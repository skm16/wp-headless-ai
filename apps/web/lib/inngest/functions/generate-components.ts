import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generateComponent,
  mergeUsageIntoComponent,
  COMPONENT_PROMPT_VERSION,
  type GenerateComponentOptions,
  type GeneratedComponent,
} from "@/lib/ai/component-generator";
import {
  isBatchGenerateEnabled,
  partitionInventoryForBatch,
  buildComponentBatchItems,
  buildWave2Item,
  finalizeComponentWave,
  pollVerdict,
  MAX_BATCH_POLLS,
  BATCH_POLL_INTERVAL,
  type Wave2Descriptor,
  type SyncFallbackDescriptor,
} from "@/lib/jab/component-batch";
import {
  submitGenerationBatch,
  getBatchStatus,
  collectBatchResults,
  cancelGenerationBatch,
  type BatchRequestItem,
} from "@/lib/ai/batch-client";
import { persistGeneration, copyComponentArtifact } from "@/lib/ai/persist-generation";
import {
  componentEntryHash,
  buildPriorHashIndex,
  selectReusablePrior,
  sha256Hex,
} from "@/lib/jab/component-carry-forward";
import { loadPriorReadyComponentRows } from "@/lib/jab/load-prior-build";
import { getModelFor } from "@/lib/ai/model";
import { COMPONENT_TASK_BY_TIER } from "@/lib/ai/model-client";
import { loadJabCredentials, resolveFrontPage } from "@/lib/jab/ability-client";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";
import type { ThemeJsonTokens, ScrapedBrandTokens } from "@/lib/jab/global-styles";
import { resolveThemeTokens } from "@/lib/jab/global-styles";
import { markBuildFailed } from "@/lib/inngest/shared-failure";
import { ACTIVE_BUILD_PHASES } from "@/lib/jab/build-status";
import { blockRowToEnrichedEntry } from "@/lib/jab/inventory-entry-from-row";
import { cptListMetaFromManifest, detectDynamicList } from "@/lib/jab/dynamic-list-detect";
import type { DynamicListSpec } from "@/lib/jab/dynamic-lists-runtime";
import type { Manifest } from "@jab/core";
import { hostVariants } from "@/lib/jab/rewrite-origin-links";
import { partitionSonnetWarmup } from "@/lib/jab/sonnet-warmup";

/**
 * generateComponents — Phase B Inngest worker.
 *
 * Triggered by `site/components.requested` (dispatched by `discoverSite`
 * when Phase A completes; Stage 7 orchestrator will dispatch from the top-
 * level `site/build.requested` fan-out).
 *
 * Steps:
 *   1. mark-components-phase — flip site_builds.status to 'components'
 *   2. load-inventory        — read block_inventory rows for buildId
 *   3. load-tokens           — read design_tokens from projects row
 *   4. generate-warmup       — one Sonnet-tier entry runs to completion
 *                              first to prime the COMPONENT_SYSTEM_CORE
 *                              cache entry before the fan-out
 *   5. generate-batch-N      — for each batch of 5 blocks (all tiers,
 *                              including passthrough), generate + persist
 *                              in parallel. generateComponent has an
 *                              early-return for passthrough that emits the
 *                              fallback TSX with compileStatus='skipped' at
 *                              zero cost — no LLM call.
 *   6. update-counts         — write component_count + flip to 'composing'
 *   7. dispatch-compose      — fire site/compose.requested
 *
 * Parallelism (sync path, default): batches of 5 concurrent generate calls.
 * Plan decision #4 (no Batch API) is re-opened behind JAB_BATCH_GENERATE=1
 * (docs/superpowers/plans/2026-06-10-ai-call-optimization/03-batch-api.md):
 * LLM-tier entries go through one Message Batch (50% off all tokens), a
 * 30s/60-poll step.sleep loop, a wave-2 corrective batch for validation
 * failures, and a sync fallback for stragglers. Flag off → the sync path
 * below runs byte-identical. JAB_GENERATE_MOCK=1 always wins (sync + mock).
 * Each sync batch runs inside a single step.run boundary
 * so the Inngest retry unit is the batch, not the individual component.
 * If one component in a batch fails, the whole batch retries — acceptable
 * because generateComponent is idempotent (compile failure → passthrough;
 * Storage upsert overwrites).
 *
 * retries: 0 — same rationale as discoverSite. Re-trigger via a fresh
 * `site/components.requested` is the recovery path.
 *
 * Status machine: 'components' on entry, 'composing' on clean exit.
 * Any throw is wrapped by a top-level try/catch that calls
 * markBuildFailed({ phase: 'components' }) so failed runs surface in the
 * site_builds row (Phase 2 of the 2026-06-02 SaaS-app completion plan).
 */

const BATCH_SIZE = 5;

/**
 * JIT screenshot download for the batch branch (the sync loop keeps its own
 * closure-local copy). Base64 bodies must NEVER be a step.run return value
 * (Inngest step-output budget) — call this INSIDE the step that needs it.
 */
async function loadScreenshotCached(
  supabase: ReturnType<typeof createAdminClient>,
  cache: Map<string, string | null>,
  pathBySlug: Record<string, string>,
  slug: string,
): Promise<string | undefined> {
  if (cache.has(slug)) return cache.get(slug) ?? undefined;
  const path = pathBySlug[slug];
  if (!path) {
    cache.set(slug, null);
    return undefined;
  }
  try {
    const { data, error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).download(path);
    if (error || !data) {
      cache.set(slug, null);
      return undefined;
    }
    const b64 = Buffer.from(await data.arrayBuffer()).toString("base64");
    cache.set(slug, b64);
    return b64;
  } catch {
    cache.set(slug, null);
    return undefined;
  }
}

interface BlockInventoryRow {
  block_name: string;
  tier: string | null;
  kind: string | null;
  spec: unknown;
  attr_samples: unknown;
  page_slugs: string[] | null;
  occurrence_count: number | null;
  source_dom_sample: string | null;
  computed_styles: unknown;
}

export const generateComponents = inngest.createFunction(
  { id: "generate-components", retries: 0 },
  { event: "site/components.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, buildId } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
    };

    try {
    // Terminal-state guard: only advance from an ACTIVE prior status. A
    // discard (cancelled) or stale auto-fail (failed) must not be
    // overwritten back to an active status. Zero rows updated = terminal
    // elsewhere — stop BEFORE any LLM spend.
    // Unreachable from 'queued' today (discover owns that boundary) — if a
    // scoped-rebuild entry point ever dispatches components on a fresh queued
    // build, add the 0031 23505 translation here (see discover-site mark-discovering).
    const componentsAdvanced = await step.run("mark-components-phase", async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("site_builds")
        .update({ status: "components", started_at: new Date().toISOString() })
        .eq("id", buildId)
        .eq("project_id", projectId)
        .in("status", [...ACTIVE_BUILD_PHASES])
        .select("id");
      if (error) throw new Error(`Failed to mark build as components: ${error.message}`);
      return (data ?? []).length > 0;
    });
    if (!componentsAdvanced) {
      console.log(`[generate-components] build ${buildId} reached a terminal state elsewhere (discard or auto-fail) — stopping.`);
      return { buildId, cancelled: true };
    }

    const inventory = await step.run("load-inventory", async (): Promise<BlockInventoryRow[]> => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("block_inventory")
        .select("block_name, tier, kind, spec, attr_samples, page_slugs, occurrence_count, source_dom_sample, computed_styles")
        .eq("site_build_id", buildId)
        .eq("project_id", projectId);
      if (error) throw new Error(`load-inventory failed: ${error.message}`);
      return (data ?? []) as BlockInventoryRow[];
    });

    const tokens = await step.run("load-tokens", async (): Promise<ThemeJsonTokens | null> => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("projects")
        .select("design_tokens")
        .eq("id", projectId)
        .eq("tenant_id", tenantId)
        .single<{ design_tokens: unknown }>();
      if (error || !data) return null;
      // design_tokens is a junk-drawer JSONB: { themeJson, themeStylesheets,
      // shellDom, personality, colors, typography }. Discovery writes WP
      // theme.json tokens under .themeJson AND the AI scrape-agent's brand
      // inference under sibling .colors / .typography keys. resolveThemeTokens
      // prefers themeJson when present and falls back to the scrape for
      // classic themes — matches compose-site.ts's resolution and unblocks
      // Phase B prompts on classic-theme pilots (Two Roads — see
      // docs/superpowers/specs/2026-05-29-two-roads-diagnosis.md).
      const container = data.design_tokens as {
        themeJson?: ThemeJsonTokens;
        colors?: ScrapedBrandTokens["colors"];
        typography?: ScrapedBrandTokens["typography"];
      } | null;
      return resolveThemeTokens(container?.themeJson, {
        colors: container?.colors,
        typography: container?.typography,
      });
    });

    // The connected site's manifest (camelCase project manifest, carrying
    // outputSchema/name) — the same value compose-site.ts reads for CPT
    // ability metadata. Used to detect config-only ACF flex "list placeholder"
    // layouts and tell the LLM the items arrive at block.attrs.items.
    // Also reads wp_url here to compute sourceHosts for origin-rewriting.
    const manifestAndWpUrl = await step.run(
      "load-manifest",
      async (): Promise<{ manifest: Manifest | null; wp_url: string | null }> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("projects")
          .select("manifest, wp_url")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single<{ manifest: unknown; wp_url: string | null }>();
        if (error || !data) return { manifest: null, wp_url: null };
        return {
          manifest: (data.manifest ?? null) as Manifest | null,
          wp_url: data.wp_url ?? null,
        };
      },
    );

    const manifest = manifestAndWpUrl.manifest;

    // Derive CPT list metadata once; reused per acf_flex entry below to detect
    // dynamic-list placeholders.
    const cpts = cptListMetaFromManifest(manifest);

    // Compute WP-origin host variants once (outside the per-entry loop) for
    // block-component TSX origin-rewriting. Fail-soft: invalid/missing wp_url
    // returns an empty array → generateComponent skips the rewrite.
    // wp_url is NOT pre-validated here (compose-site validates + hard-throws); fail-soft to [] so a malformed URL never kills Phase B.
    const sourceHosts = (() => {
      if (!manifestAndWpUrl.wp_url) return [];
      try {
        return hostVariants(manifestAndWpUrl.wp_url);
      } catch {
        return [];
      }
    })();

    // Load per-page 1280-viewport screenshot storage paths from page_inventory.
    // Used per-entry below to thread visual context into the visual-tier
    // prompt. Map only — actual base64 bodies are downloaded just-in-time
    // inside each batch's step.run to keep this step's output small (the
    // map values stay under the Inngest per-step output size limit).
    //
    // Fail-soft: pages without a 1280 screenshot path are silently omitted.
    // page_inventory.source_screenshot_paths shape (set by persist-pages):
    //   { source: { "375": "<path>", "768": "<path>", "1280": "<path>" } }
    // Only the 1280 viewport is used here — visual tier prompts get desktop
    // context. The mobile + tablet captures stay available for Phase E
    // (verify) and future per-viewport prompting.
    const pageSlugToScreenshotPath = await step.run(
      "load-page-screenshot-paths",
      async (): Promise<Record<string, string>> => {
        const supabase = createAdminClient();
        const { data: pages } = await supabase
          .from("page_inventory")
          .select("slug, source_screenshot_paths")
          .eq("site_build_id", buildId);
        const result: Record<string, string> = {};
        for (const page of (pages ?? []) as Array<{
          slug: string;
          source_screenshot_paths: unknown;
        }>) {
          const paths =
            (page.source_screenshot_paths as { source?: Record<string, string> } | null)?.source ??
            {};
          const path1280 = paths["1280"];
          if (path1280) result[page.slug] = path1280;
        }
        return result;
      },
    );

    // Best-effort resolution of the WP static front-page slug. When set, the
    // queue-ordering step below treats it as a homepage slug so the canonical
    // front-page's blocks generate first. Returns null for the latest-posts-
    // feed case or any settings-fetch failure — we fall back to the common-
    // slugs set, not throw, because front-page detection is an optimization,
    // not a correctness requirement.
    const frontPageSlug = await step.run("resolve-front-page", async (): Promise<string | null> => {
      try {
        const creds = await loadJabCredentials(projectId, tenantId);
        const fp = await resolveFrontPage(creds);
        return fp?.slug ?? null;
      } catch {
        return null;
      }
    });

    // ── Cross-build component carry-forward (JAB_COMPONENT_REUSE, OFF by
    // default — audit: component-generator issue 7). Mirrors discover-site's
    // JAB_INCREMENTAL_SKIP gate shape (discover-site.ts:340): with the flag
    // off this performs ZERO extra reads and the per-entry LLM path below is
    // unchanged. The step output is a JSON-safe array; the Map index is
    // built AFTER the step boundary (Inngest serializes step output).
    const reuseEnabled = process.env.JAB_COMPONENT_REUSE === "1";
    const priorComponents = reuseEnabled
      ? await step.run("load-prior-components", () => loadPriorReadyComponentRows(projectId))
      : null;
    const priorHashIndex = buildPriorHashIndex(priorComponents?.rows ?? []);

    // Process every inventory row — passthrough included. generateComponent's
    // early-return at component-generator.ts handles tier==="passthrough" and
    // blockName===null without calling the LLM (returns passthroughFallback
    // TSX with compileStatus="skipped"). Excluding passthrough here would
    // strand those rows at compile_status=null and skip their fallback .tsx
    // write to Storage, breaking the composer's expectation that every
    // inventory row has a corresponding component file.
    const queue: EnrichedInventoryEntry[] = inventory.map((row) => blockRowToEnrichedEntry(row));

    // Homepage-first ordering: blocks that appear on a front-page slug come
    // first (enables Phase C₁ homepage compose to start without waiting for
    // the full queue). Remaining blocks ordered descending by occurrence count.
    //
    // The slug set unions the WP-resolved front-page slug (canonical when
    // available) with three common fallbacks. The fallbacks cover WP installs
    // configured with show_on_front='posts' (no static front page; the
    // latest-posts feed lives at /) and the transient case where the
    // resolve-front-page step couldn't reach /wp-json/wp/v2/settings.
    const homepageSlugs = new Set<string>(["home", "homepage", "/"]);
    if (frontPageSlug) homepageSlugs.add(frontPageSlug);
    queue.sort((a, b) => {
      const aOnHome = a.pageSlugs.some((s) => homepageSlugs.has(s)) ? 0 : 1;
      const bOnHome = b.pageSlugs.some((s) => homepageSlugs.has(s)) ? 0 : 1;
      if (aOnHome !== bOnHome) return aOnHome - bOnHome;
      return b.occurrenceCount - a.occurrenceCount;
    });

    let generatedCount = 0;
    let reusedCount = 0;

    // ── Phase 4: prompt-inputs hash. Computed for EVERY LLM-tier
    // entry regardless of the reuse flag so block_inventory rows
    // accumulate hashes that future reuse-enabled builds can match.
    // Null for passthrough/null-blockName rows (no LLM, no artifact
    // worth reusing). Model resolution matches what
    // modelClientForTier will use (Phase 1: getModelFor by tier
    // task); sourceHost matches component-generator.ts's
    // `opts.sourceHosts?.[0] ?? null` prompt input. Shared by the sync
    // path AND the JAB_BATCH_GENERATE wave-1 submit loop so the two
    // paths can never drift on what feeds the hash.
    const hashEntryPromptInputs = (
      entry: EnrichedInventoryEntry,
      dynamicList: DynamicListSpec | null,
      screenshotBase64: string | undefined,
    ): string | null => {
      // Never persist a hash for mock-mode rows — MockModelClient emits identical
      // TSX for every block regardless of inputs, so hash-matching a mock row
      // would copy the MOCK amber-badge component into a real production build.
      if (process.env.JAB_GENERATE_MOCK === "1") return null;
      const entryModel =
        entry.tier === "visual" || entry.tier === "standard" || entry.tier === "trivial"
          ? getModelFor(COMPONENT_TASK_BY_TIER[entry.tier])
          : null;
      return entryModel
        ? componentEntryHash({
            blockName: entry.blockName,
            tier: entry.tier,
            model: entryModel,
            promptVersion: COMPONENT_PROMPT_VERSION,
            attrSamples: entry.attrSamples,
            occurrenceCount: entry.occurrenceCount,
            pageSlugs: entry.pageSlugs,
            spec: "spec" in entry ? entry.spec : null,
            dynamicList,
            domSample: entry.sourceDomSample ?? null,
            computedStyles: entry.computedStyles ?? null,
            tokens,
            sourceHost: sourceHosts[0] ?? null,
            screenshotSha256: screenshotBase64 ? sha256Hex(screenshotBase64) : null,
          })
        : null;
    };

    // Shared per-step processor: the warm-up step and every batch step run
    // the same generate + persist path. Defined here (not module scope) so
    // it closes over tokens / screenshot paths / cpts / sourceHosts.
    async function processEntries(
      entries: EnrichedInventoryEntry[],
    ): Promise<{ succeeded: number; reused: number }> {
      // Cache base64 screenshots within the step — multiple visual-tier
      // entries on the same page share one download.
      const screenshotCache = new Map<string, string | null>();
      const supabase = createAdminClient();

      async function loadScreenshot(slug: string): Promise<string | null> {
        if (screenshotCache.has(slug)) return screenshotCache.get(slug) ?? null;
        const path = pageSlugToScreenshotPath[slug];
        if (!path) {
          screenshotCache.set(slug, null);
          return null;
        }
        try {
          const { data, error } = await supabase.storage
            .from(SITE_SCREENSHOTS_BUCKET)
            .download(path);
          if (error || !data) {
            screenshotCache.set(slug, null);
            return null;
          }
          const buf = Buffer.from(await data.arrayBuffer());
          const b64 = buf.toString("base64");
          screenshotCache.set(slug, b64);
          return b64;
        } catch {
          // Fail-soft: a transient download error just means no screenshot
          // for this entry. Component generation still runs against the
          // remaining inputs (ACF schema, attr samples, tokens).
          screenshotCache.set(slug, null);
          return null;
        }
      }

      const results = await Promise.all(
        entries.map(async (entry) => {
          // Only the visual tier consumes screenshots in component-generator;
          // skip the download for other tiers to save bytes + time.
          let screenshotBase64: string | undefined;
          if (entry.tier === "visual" && entry.pageSlugs.length > 0) {
            const b64 = await loadScreenshot(entry.pageSlugs[0]);
            screenshotBase64 = b64 ?? undefined;
          }
          // For acf_flex layouts, detect whether this is a config-only
          // dynamic-list placeholder (e.g. upcoming_events) so the prompt can
          // teach the items contract. Null for static layouts / non-flex.
          let dynamicList: DynamicListSpec | null = null;
          if (entry.kind === "acf_flex" && entry.blockName) {
            const spec = entry.spec as Record<string, unknown> | undefined;
            const firstSample = entry.attrSamples[0] as Record<string, unknown> | undefined;
            const attrSample = spec ?? firstSample ?? {};
            dynamicList = detectDynamicList({ blockName: entry.blockName, attrSample, cpts });
          }
          // Phase 4: prompt-inputs hash (see hashEntryPromptInputs above) —
          // computed for every LLM-tier entry regardless of the reuse flag.
          const promptInputsHash = hashEntryPromptInputs(entry, dynamicList, screenshotBase64);

          // ── reuse branch: hash-match against the prior ready build ──
          // (flag-gated; selectReusablePrior is null when reuseEnabled=false).
          // Copy the prior artifact + write a zero-token telemetry row; fall
          // back to the LLM on copy failure.
          const prior = selectReusablePrior({
            flagEnabled: reuseEnabled,
            hash: promptInputsHash,
            index: priorHashIndex,
          });
          if (prior && priorComponents) {
            const copied = await copyComponentArtifact(
              supabase,
              priorComponents.buildId,
              buildId,
              prior.block_name,
            );
            if (copied) {
              const reusedComponent: GeneratedComponent = {
                blockName: prior.block_name,
                // tsx stays null: the artifact was copied object-to-object
                // above, so persistGeneration must not re-upload.
                tsx: null,
                compileStatus: "ok",
                compileAttemptCount: 0,
                modelUsed: prior.model_used,
                providerUsed: prior.provider_used === "anthropic" ? "anthropic" : null,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                failureKind: null,
              };
              const { storagePath } = await persistGeneration({
                buildId,
                projectId,
                component: reusedComponent,
                promptInputsHash,
                reusedFromBuildId: priorComponents.buildId,
              });
              return { entry, component: reusedComponent, storagePath, reused: true };
            }
            console.warn(
              `[generate-components] reuse copy failed for ${prior.block_name} — regenerating via LLM`,
            );
          }

          // ── LLM branch ──
          const component = await generateComponent({ entry, tokens, screenshotBase64, dynamicList, sourceHosts });
          const { storagePath } = await persistGeneration({ buildId, projectId, component, promptInputsHash });
          return { entry, component, storagePath, reused: false };
        }),
      );
      return {
        succeeded: results.filter((r) => r.component.compileStatus !== "failed").length,
        reused: results.filter((r) => r.reused).length,
      };
    }

    const batchEnabled = isBatchGenerateEnabled(process.env);

    if (!batchEnabled) {
      // ─── SYNC PATH (default) — UNCHANGED, byte-identical to pre-phase ───
      // Prompt-cache warm-up (Phase 2): run the FIRST Sonnet-tier entry alone
      // and await its completion — the response writes the COMPONENT_SYSTEM_CORE
      // cache entry. Concurrent identical-prefix requests all miss (an entry is
      // readable only once the first response begins streaming), so without this
      // the entire first 5-way batch would pay full input price.
      const { warmup, rest } = partitionSonnetWarmup(queue);
      if (warmup) {
        const warmupCounts = await step.run("generate-warmup", async () => processEntries([warmup]));
        generatedCount += warmupCounts.succeeded;
        reusedCount += warmupCounts.reused;
      }

      const batches: EnrichedInventoryEntry[][] = [];
      for (let i = 0; i < rest.length; i += BATCH_SIZE) {
        batches.push(rest.slice(i, i + BATCH_SIZE));
      }

      for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const batchCounts = await step.run(`generate-batch-${batchIdx}`, async () => processEntries(batch));
        generatedCount += batchCounts.succeeded;
        reusedCount += batchCounts.reused;
      }
    } else {
      // ─── BATCH PATH (JAB_BATCH_GENERATE=1) ───
      const { llmEntries, passthroughEntries } = partitionInventoryForBatch(queue);

      // Per-entry options builder shared by submit steps + sync fallback.
      // Deterministic per replay — rebuilt from step-memoized inputs.
      const entryByBlockName = new Map<string, EnrichedInventoryEntry>(
        llmEntries.map((e) => [e.blockName as string, e]),
      );
      const optionsForEntry = (
        entry: EnrichedInventoryEntry,
        screenshotBase64: string | undefined,
      ): GenerateComponentOptions => {
        let dynamicList: DynamicListSpec | null = null;
        if (entry.kind === "acf_flex" && entry.blockName) {
          const spec = entry.spec as Record<string, unknown> | undefined;
          const firstSample = entry.attrSamples[0] as Record<string, unknown> | undefined;
          dynamicList = detectDynamicList({
            blockName: entry.blockName,
            attrSample: spec ?? firstSample ?? {},
            cpts,
          });
        }
        return { entry, tokens, screenshotBase64, dynamicList, sourceHosts };
      };

      // 1. Passthrough rows: zero-LLM early-return, persisted like the sync loop.
      if (passthroughEntries.length > 0) {
        const passthroughOk = await step.run("batch-passthrough", async () => {
          let ok = 0;
          for (const entry of passthroughEntries) {
            const component = await generateComponent({ entry, tokens, sourceHosts });
            await persistGeneration({ buildId, projectId, component });
            if (component.compileStatus !== "failed") ok++;
          }
          return ok;
        });
        generatedCount += passthroughOk;
      }

      let wave2: Wave2Descriptor[] = [];
      let syncFallback: SyncFallbackDescriptor[] = [];
      // Phase 4: hash-by-block-name from the wave-1 submit step output —
      // replay-safe (closure state would be empty on a memoized replay).
      // Covers NON-REUSED entries only: reused entries' hashes were already
      // persisted inside the submit step (alongside the artifact copy), so
      // they are deliberately absent here. Threaded into every downstream
      // batch-path persist so "always persist the hash" holds for
      // batch-generated rows exactly as it does on the sync path.
      let batchPromptHashes: Record<string, string | null> = {};

      if (llmEntries.length > 0) {
        // 2. Wave-1 submit. Screenshots download INSIDE the step.
        //    Phase 4: the prompt-inputs hash + flag-gated reuse check run
        //    BEFORE an entry joins the batch request list — a reused entry
        //    must never be submitted to the Batch API (its artifact is
        //    copied + a zero-token telemetry row persisted instead).
        //    batchId is null when every LLM-tier entry reused.
        const wave1 = await step.run(
          "batch-submit-wave-1",
          async (): Promise<{
            batchId: string | null;
            blockNameByCustomId: Record<string, string>;
            promptInputsHashByBlockName: Record<string, string | null>;
            reusedBlockNames: string[];
          }> => {
            const supabase = createAdminClient();
            const cache = new Map<string, string | null>();
            const entryOptions: Array<{
              entry: EnrichedInventoryEntry;
              options: GenerateComponentOptions;
            }> = [];
            const promptInputsHashByBlockName: Record<string, string | null> = {};
            const reusedBlockNames: string[] = [];
            for (const entry of llmEntries) {
              let screenshotBase64: string | undefined;
              if (entry.tier === "visual" && entry.pageSlugs.length > 0) {
                screenshotBase64 = await loadScreenshotCached(
                  supabase, cache, pageSlugToScreenshotPath, entry.pageSlugs[0],
                );
              }
              const options = optionsForEntry(entry, screenshotBase64);
              const promptInputsHash = hashEntryPromptInputs(
                entry, options.dynamicList ?? null, screenshotBase64,
              );
              const prior = selectReusablePrior({
                flagEnabled: reuseEnabled,
                hash: promptInputsHash,
                index: priorHashIndex,
              });
              if (prior && priorComponents) {
                const copied = await copyComponentArtifact(
                  supabase,
                  priorComponents.buildId,
                  buildId,
                  prior.block_name,
                );
                if (copied) {
                  const reusedComponent: GeneratedComponent = {
                    blockName: prior.block_name,
                    // tsx stays null: the artifact was copied object-to-object
                    // above, so persistGeneration must not re-upload.
                    tsx: null,
                    compileStatus: "ok",
                    compileAttemptCount: 0,
                    modelUsed: prior.model_used,
                    providerUsed: prior.provider_used === "anthropic" ? "anthropic" : null,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    failureKind: null,
                  };
                  await persistGeneration({
                    buildId,
                    projectId,
                    component: reusedComponent,
                    promptInputsHash,
                    reusedFromBuildId: priorComponents.buildId,
                  });
                  reusedBlockNames.push(prior.block_name);
                  continue;
                }
                console.warn(
                  `[generate-components] reuse copy failed for ${prior.block_name} — regenerating via LLM`,
                );
              }
              promptInputsHashByBlockName[entry.blockName as string] = promptInputsHash;
              entryOptions.push({ entry, options });
            }
            if (entryOptions.length === 0) {
              console.log(
                `[generate-components] batch wave-1 skipped: all ${llmEntries.length} LLM-tier entries reused from prior build`,
              );
              return {
                batchId: null,
                blockNameByCustomId: {},
                promptInputsHashByBlockName,
                reusedBlockNames,
              };
            }
            const plan = buildComponentBatchItems(entryOptions);
            const batchId = await submitGenerationBatch(plan.items);
            console.log(
              `[generate-components] batch wave-1 submitted: ${plan.items.length} items, batch ${batchId}`,
            );
            return {
              batchId,
              blockNameByCustomId: plan.blockNameByCustomId,
              promptInputsHashByBlockName,
              reusedBlockNames,
            };
          },
        );
        batchPromptHashes = wave1.promptInputsHashByBlockName;
        // Reused rows have compileStatus 'ok' — they count toward
        // generatedCount / component_count exactly as a fresh generation would.
        generatedCount += wave1.reusedBlockNames.length;
        reusedCount += wave1.reusedBlockNames.length;
        const reusedSet = new Set(wave1.reusedBlockNames);
        const waveEntries = llmEntries.filter(
          (e) => e.blockName !== null && !reusedSet.has(e.blockName),
        );
        const wave1BatchId = wave1.batchId;

        if (wave1BatchId !== null) {
          // 3. Durable poll loop: up to 61 polls (poll-0..poll-60) × 30s sleeps
          //    ≈ 30.5 min worst case (pollVerdict times out at polls >= MAX_BATCH_POLLS).
          let polls = 0;
          let verdict: "collect" | "wait" | "timeout" = "wait";
          while (verdict === "wait") {
            const status = await step.run(`batch-wave1-poll-${polls}`, () =>
              getBatchStatus(wave1BatchId),
            );
            verdict = pollVerdict(status, polls);
            if (verdict === "wait") {
              polls++;
              // 0-indexed to align with poll IDs: sleep-N follows poll-N.
              await step.sleep(`batch-wave1-sleep-${polls - 1}`, BATCH_POLL_INTERVAL);
            }
          }

          let collectable = verdict === "collect";
          if (verdict === "timeout") {
            // Stop paying for a batch we won't wait for; drain once so already-
            // finished rows are still collected before the sync fallback.
            await step.run("batch-wave1-cancel", () => cancelGenerationBatch(wave1BatchId));
            await step.sleep("batch-wave1-drain-sleep", BATCH_POLL_INTERVAL);
            const drained = await step.run("batch-wave1-drain-poll", () =>
              getBatchStatus(wave1BatchId),
            );
            collectable = drained === "ended";
            console.warn(
              `[generate-components] batch wave-1 timed out after ${MAX_BATCH_POLLS} polls (collectable=${collectable})`,
            );
          }

          // 4. Finalize wave-1: collect → validate → persist terminal rows.
          //    Step output carries ONLY small descriptors (never TSX).
          //    Reused entries are excluded — their terminal row was persisted
          //    in the submit step and must not be routed to the sync fallback.
          const wave1Outcome = await step.run("batch-finalize-wave-1", async () =>
            finalizeComponentWave({
              buildId,
              projectId,
              results: collectable ? await collectBatchResults(wave1BatchId) : [],
              blockNameByCustomId: wave1.blockNameByCustomId,
              entries: waveEntries,
              attempt: 1,
              sourceHosts,
              priorUsageByBlockName: {},
              persist: (input) =>
                persistGeneration({
                  ...input,
                  promptInputsHash: batchPromptHashes[input.component.blockName] ?? null,
                }),
            }),
          );
          generatedCount += wave1Outcome.okCount;
          wave2 = wave1Outcome.retry;
          syncFallback = wave1Outcome.syncFallback;
        }
      }

      // 5. Wave-2 corrective batch (validation/max_tokens failures only).
      if (wave2.length > 0) {
        const wave2Submit = await step.run("batch-submit-wave-2", async () => {
          const supabase = createAdminClient();
          const cache = new Map<string, string | null>();
          const taken = new Set<string>();
          const items: BatchRequestItem[] = [];
          const blockNameByCustomId: Record<string, string> = {};
          for (const descriptor of wave2) {
            const entry = entryByBlockName.get(descriptor.blockName);
            if (!entry) continue;
            let screenshotBase64: string | undefined;
            if (entry.tier === "visual" && entry.pageSlugs.length > 0) {
              screenshotBase64 = await loadScreenshotCached(
                supabase, cache, pageSlugToScreenshotPath, entry.pageSlugs[0],
              );
            }
            const item = buildWave2Item({
              descriptor,
              options: optionsForEntry(entry, screenshotBase64),
              taken,
            });
            blockNameByCustomId[item.customId] = descriptor.blockName;
            items.push(item);
          }
          const batchId = await submitGenerationBatch(items);
          console.log(
            `[generate-components] batch wave-2 submitted: ${items.length} corrective items, batch ${batchId}`,
          );
          return { batchId, blockNameByCustomId };
        });

        // Durable poll loop: up to 61 polls (poll-0..poll-60) × 30s sleeps
        // ≈ 30.5 min worst case (pollVerdict times out at polls >= MAX_BATCH_POLLS).
        let polls2 = 0;
        let verdict2: "collect" | "wait" | "timeout" = "wait";
        while (verdict2 === "wait") {
          const status = await step.run(`batch-wave2-poll-${polls2}`, () =>
            getBatchStatus(wave2Submit.batchId),
          );
          verdict2 = pollVerdict(status, polls2);
          if (verdict2 === "wait") {
            polls2++;
            // 0-indexed to align with poll IDs: sleep-N follows poll-N.
            await step.sleep(`batch-wave2-sleep-${polls2 - 1}`, BATCH_POLL_INTERVAL);
          }
        }

        let collectable2 = verdict2 === "collect";
        if (verdict2 === "timeout") {
          await step.run("batch-wave2-cancel", () => cancelGenerationBatch(wave2Submit.batchId));
          await step.sleep("batch-wave2-drain-sleep", BATCH_POLL_INTERVAL);
          const drained = await step.run("batch-wave2-drain-poll", () =>
            getBatchStatus(wave2Submit.batchId),
          );
          collectable2 = drained === "ended";
        }

        const wave2Outcome = await step.run("batch-finalize-wave-2", async () =>
          finalizeComponentWave({
            buildId,
            projectId,
            results: collectable2 ? await collectBatchResults(wave2Submit.batchId) : [],
            blockNameByCustomId: wave2Submit.blockNameByCustomId,
            entries: wave2
              .map((d) => entryByBlockName.get(d.blockName))
              .filter((e): e is EnrichedInventoryEntry => e !== undefined),
            attempt: 2,
            sourceHosts,
            priorUsageByBlockName: Object.fromEntries(wave2.map((d) => [d.blockName, d.usage])),
            priorAttemptsByBlockName: Object.fromEntries(
              wave2.map((d) => [d.blockName, d.attempts]),
            ),
            persist: (input) =>
              persistGeneration({
                ...input,
                promptInputsHash: batchPromptHashes[input.component.blockName] ?? null,
              }),
          }),
        );
        generatedCount += wave2Outcome.okCount;
        syncFallback = syncFallback.concat(wave2Outcome.syncFallback);
      }

      // 6. Sync fallback for stragglers (API failures / unfinished batches):
      //    the normal generateComponent path, prior wave spend merged in.
      for (let i = 0; i < syncFallback.length; i += BATCH_SIZE) {
        const chunk = syncFallback.slice(i, i + BATCH_SIZE);
        const chunkOk = await step.run(`batch-sync-fallback-${i / BATCH_SIZE}`, async () => {
          const supabase = createAdminClient();
          const cache = new Map<string, string | null>();
          let ok = 0;
          for (const descriptor of chunk) {
            const entry = entryByBlockName.get(descriptor.blockName);
            if (!entry) continue;
            let screenshotBase64: string | undefined;
            if (entry.tier === "visual" && entry.pageSlugs.length > 0) {
              screenshotBase64 = await loadScreenshotCached(
                supabase, cache, pageSlugToScreenshotPath, entry.pageSlugs[0],
              );
            }
            const generated = await generateComponent(optionsForEntry(entry, screenshotBase64));
            const component = mergeUsageIntoComponent(
              generated, descriptor.usage, descriptor.attempts,
            );
            await persistGeneration({
              buildId,
              projectId,
              component,
              promptInputsHash: batchPromptHashes[descriptor.blockName] ?? null,
            });
            if (component.compileStatus !== "failed") ok++;
          }
          return ok;
        });
        generatedCount += chunkOk;
      }
    }

    // Terminal-state guard (see mark-components-phase). MUST run before the
    // compose dispatch below — a terminal build never dispatches compose.
    const countsAdvanced = await step.run("update-counts", async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("site_builds")
        .update({
          status: "composing",
          component_count: generatedCount,
          finished_at: new Date().toISOString(),
        })
        .eq("id", buildId)
        .eq("project_id", projectId)
        .in("status", [...ACTIVE_BUILD_PHASES])
        .select("id");
      if (error) throw new Error(`Failed to update build counts: ${error.message}`);
      return (data ?? []).length > 0;
    });
    if (!countsAdvanced) {
      console.log(`[generate-components] build ${buildId} reached a terminal state elsewhere (discard or auto-fail) — stopping.`);
      return { buildId, cancelled: true };
    }

    await step.sendEvent("dispatch-compose", {
      name: "site/compose.requested",
      data: { projectId, tenantId, buildId },
    });

    if (reusedCount > 0) {
      console.log(`[generate-components] ${reusedCount}/${queue.length} components reused from prior build (JAB_COMPONENT_REUSE)`);
    }
    return { buildId, generatedCount, reusedCount, queueLength: queue.length };
    } catch (err) {
      await markBuildFailed({ buildId, projectId, phase: "components", error: err });
      throw err;
    }
  },
);
