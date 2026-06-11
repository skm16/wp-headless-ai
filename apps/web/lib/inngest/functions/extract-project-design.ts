import "server-only";
import { inngest } from "../client";
import { runDesignTokenScrape } from "@/lib/ai/scrape-agent";
import { captureAssets } from "@/lib/ai/asset-capture";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * extractProjectDesign — Stage 2 background worker.
 *
 * Triggered after the user completes the WP credentials probe in
 * `connectWpAction`. Async on purpose — onboarding should NOT block
 * on this LLM call. Downstream build phases (Stage 7's `siteBuild`
 * fanout) consume the persisted design + personality + cached assets
 * from the project row.
 *
 * Steps:
 *   1. scrape ($) — single design-token extraction against the WP homepage
 *                   (fetch + deterministic signals + one LLM call for
 *                   typography/buttonPair/personality).
 *   2. capture-assets ($) — download logo / favicon / OG image into
 *                           `projects/<projectId>/<kind>.<ext>`. Overrides
 *                           any wow-flow snapshot — the connected site is
 *                           the more authoritative source.
 *   3. persist — write design_tokens + personality + design_scrape_usage
 *                (cost telemetry, migration 0034) + asset paths to the
 *                project row.
 *
 * Failures: any step throw fails the function. Inngest dev UI logs the
 * trace. The project row is left without design_tokens — downstream
 * renders fall back to whatever the wow-preview scrape captured.
 *
 * `retries: 0` — the failure modes here are mostly deterministic (bad
 * URL, Sonnet rejected JSON shape) and retries waste tokens. Manual
 * re-trigger via re-running the probe is the recovery path.
 *
 * Idempotency: latest write wins. The user can re-run the probe; each
 * dispatch overwrites the previous extraction. Asset uploads use upsert.
 * A per-project debounce (2m) coalesces the onboarding + discover-site
 * duplicate-dispatch race into a single billed run.
 */
export const extractProjectDesign = inngest.createFunction(
  {
    id: "extract-project-design",
    retries: 0,
    // Duplicate-dispatch guard: connectWpAction (onboarding.ts) and
    // discover-site's warn-design-tokens step both dispatch
    // project/design.requested — the latter whenever design_tokens is
    // still null, i.e. exactly while an onboarding-dispatched run may
    // still be in flight. Debounce coalesces same-project events inside
    // a rolling 2-minute window into ONE run executed with the LATEST
    // event (matching the documented latest-write-wins semantics below).
    // Deliberately NOT `idempotency`: that dedupes for 24h and would
    // break the documented recovery path (re-running the probe must be
    // able to re-extract immediately).
    debounce: { key: "event.data.projectId", period: "2m" },
  },
  { event: "project/design.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, wpUrl } = event.data as {
      projectId: string;
      tenantId: string;
      wpUrl: string;
    };

    const scrape = await step.run("scrape", async () => {
      return runDesignTokenScrape({
        url: wpUrl,
        label: `extractProjectDesign ${projectId}`,
      });
    });

    const assets = await step.run("capture-assets", async () => {
      const result = await captureAssets(
        {
          logo: scrape.design.logo.src,
          favicon: scrape.extract.faviconUrl,
          ogImage: scrape.extract.socialImage,
        },
        // Goes directly to the project-scoped path — no preview era to
        // bridge from for Stage 2.
        { pathPrefix: `projects/${projectId}` },
      );
      if (Object.keys(result.failures).length > 0) {
        console.warn(
          `[extractProjectDesign ${projectId}] asset capture partial:`,
          result.failures,
        );
      }
      return result;
    });

    await step.run("persist", async () => {
      // Split DesignAnalysis: personality on its own column, the rest goes
      // into design_tokens. Consumers that only need tone/energy/audience
      // (e.g. iteration-prompt copy decisions) don't have to pull the
      // heavier color / typography payload.
      const { personality, ...designTokens } = scrape.design;

      // Only overwrite asset paths when capture-assets actually produced
      // a value. The wow-flow promote-on-signup may have populated paths
      // earlier; we should NOT null those out just because Stage 2 didn't
      // find a logo today (e.g. the AI classified the public homepage but
      // couldn't pick a clear logo image). Null in `assets.*` means
      // "no signal," not "clear non-existence."
      const updatePayload: Record<string, unknown> = {
        design_tokens: designTokens,
        personality,
        // Cost/fallback telemetry for the design pass — includes the wasted
        // primary call's usage when the Haiku→Sonnet fallback fired.
        // Column: migration 0034_ai_cost_telemetry.sql (jsonb).
        design_scrape_usage: scrape.scrapeUsage,
      };
      if (assets.logoPath !== null) updatePayload.logo_storage_path = assets.logoPath;
      if (assets.faviconPath !== null) updatePayload.favicon_storage_path = assets.faviconPath;
      if (assets.ogImagePath !== null) updatePayload.og_image_storage_path = assets.ogImagePath;

      const supabase = createAdminClient();
      // Belt-and-suspenders: filter on both `id` AND `tenant_id`. With
      // service-role bypassing RLS, this filter is the application-layer
      // guard against a stray dispatch landing the write on the wrong
      // project. `.select("id")` lets us detect the no-row case (the
      // service-role update returns no error when zero rows match).
      const { data: updated, error } = await supabase
        .from("projects")
        .update(updatePayload)
        .eq("id", projectId)
        .eq("tenant_id", tenantId)
        .select("id");

      if (error) {
        throw new Error(
          `persist design failed for projectId=${projectId}: ${error.message}`,
        );
      }
      if (!updated || updated.length === 0) {
        // No row matched id + tenant_id. Either the project was deleted,
        // or the dispatched payload had a mismatched tenantId (which is
        // exactly what this filter is for). Throw so Inngest surfaces it.
        throw new Error(
          `persist design no-op — project ${projectId} / tenant ${tenantId} not found or tenant mismatch`,
        );
      }
    });
  },
);
