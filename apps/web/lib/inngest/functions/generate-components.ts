import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateComponent } from "@/lib/ai/component-generator";
import { persistGeneration } from "@/lib/ai/persist-generation";
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
 *   4. generate-batch-N      — for each batch of 5 blocks (all tiers,
 *                              including passthrough), generate + persist
 *                              in parallel. generateComponent has an
 *                              early-return for passthrough that emits the
 *                              fallback TSX with compileStatus='skipped' at
 *                              zero cost — no LLM call.
 *   5. update-counts         — write component_count + flip to 'composing'
 *   6. dispatch-compose      — fire site/compose.requested
 *
 * Parallelism: batches of 5 concurrent generate calls (not Batch API —
 * see plan decision #4). Each batch runs inside a single step.run boundary
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

    const batches: EnrichedInventoryEntry[][] = [];
    for (let i = 0; i < queue.length; i += BATCH_SIZE) {
      batches.push(queue.slice(i, i + BATCH_SIZE));
    }

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const batchSucceeded = await step.run(`generate-batch-${batchIdx}`, async () => {
        // Cache base64 screenshots within the batch — multiple visual-tier
        // entries on the same page share one download. With BATCH_SIZE=5
        // and typical sites having more pages than blocks-per-page, hits
        // are rare but cheap when they happen.
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
          batch.map(async (entry) => {
            // Only the visual tier consumes screenshots in component-generator;
            // skip the download for other tiers to save bytes + time. ACF flex
            // entries are tier=visual; cpt_template entries are tier=standard
            // (no screenshot per current contract).
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
              // For an acf_flex entry, `spec` is the captured attrSample
              // (content-detection.ts), so it is the detector's attrSample;
              // fall back to the first attr sample / empty for robustness.
              // Read the two fields into locals first: chaining `??` directly
              // on the discriminated-union member narrows `entry` to `never`
              // in the right operand (TS treats `spec` as never-nullish).
              const spec = entry.spec as Record<string, unknown> | undefined;
              const firstSample = entry.attrSamples[0] as Record<string, unknown> | undefined;
              const attrSample = spec ?? firstSample ?? {};
              dynamicList = detectDynamicList({ blockName: entry.blockName, attrSample, cpts });
            }
            const component = await generateComponent({ entry, tokens, screenshotBase64, dynamicList, sourceHosts });
            const { storagePath } = await persistGeneration({ buildId, projectId, component });
            return { entry, component, storagePath };
          }),
        );
        return results.filter((r) => r.component.compileStatus !== "failed").length;
      });
      generatedCount += batchSucceeded;
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

    return { buildId, generatedCount, queueLength: queue.length };
    } catch (err) {
      await markBuildFailed({ buildId, projectId, phase: "components", error: err });
      throw err;
    }
  },
);
