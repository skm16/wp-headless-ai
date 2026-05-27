import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateComponent } from "@/lib/ai/component-generator";
import { persistGeneration } from "@/lib/ai/persist-generation";
import { loadJabCredentials, resolveFrontPage } from "@/lib/jab/ability-client";
import type { EnrichedInventoryEntry, Tier, ContentKind } from "@/lib/jab/inventory";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

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
 * Errors are not caught at function level — Inngest's retries: 0 means
 * a thrown error surfaces as a failed run in the dev UI. Stage 7 will
 * add a top-level catcher that flips site_builds.status to 'failed'.
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

    await step.run("mark-components-phase", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("site_builds")
        .update({ status: "components", started_at: new Date().toISOString() })
        .eq("id", buildId)
        .eq("project_id", projectId);
      if (error) throw new Error(`Failed to mark build as components: ${error.message}`);
    });

    const inventory = await step.run("load-inventory", async (): Promise<BlockInventoryRow[]> => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("block_inventory")
        .select("block_name, tier, kind, spec, attr_samples, page_slugs, occurrence_count")
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
      return data.design_tokens as ThemeJsonTokens | null;
    });

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
    const queue: EnrichedInventoryEntry[] = inventory.map((row) => {
      const kind = (row.kind ?? "block") as ContentKind;
      const tier = (row.tier ?? "passthrough") as Tier;
      // DB stores the "no block name" sentinel as the literal string "__null__"
      // because block_name is NOT NULL; the TS-side discriminator is
      // blockName: string | null. Convert here so the entry type is correct.
      const blockName = row.block_name === "__null__" ? null : row.block_name;
      const base = {
        blockName,
        tier,
        attrSamples: Array.isArray(row.attr_samples)
          ? (row.attr_samples as Array<Record<string, unknown>>)
          : [],
        pageSlugs: row.page_slugs ?? [],
        occurrenceCount: row.occurrence_count ?? 0,
      };
      if (kind === "acf_flex") {
        return { ...base, kind, spec: (row.spec ?? {}) as Record<string, unknown> };
      }
      if (kind === "cpt_template") {
        return { ...base, kind, spec: (row.spec ?? []) as (string | null)[] };
      }
      return { ...base, kind: "block", spec: undefined };
    });

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
        const results = await Promise.all(
          batch.map(async (entry) => {
            const component = await generateComponent({ entry, tokens });
            const { storagePath } = await persistGeneration({ buildId, projectId, component });
            return { entry, component, storagePath };
          }),
        );
        return results.filter((r) => r.component.compileStatus !== "failed").length;
      });
      generatedCount += batchSucceeded;
    }

    await step.run("update-counts", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("site_builds")
        .update({
          status: "composing",
          component_count: generatedCount,
          finished_at: new Date().toISOString(),
        })
        .eq("id", buildId)
        .eq("project_id", projectId);
      if (error) throw new Error(`Failed to update build counts: ${error.message}`);
    });

    await step.sendEvent("dispatch-compose", {
      name: "site/compose.requested",
      data: { projectId, tenantId, buildId },
    });

    return { buildId, generatedCount, queueLength: queue.length };
  },
);
