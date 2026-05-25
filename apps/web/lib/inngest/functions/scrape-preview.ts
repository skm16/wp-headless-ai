import "server-only";
import { inngest } from "../client";
import { runScrapeAgent } from "@/lib/ai/scrape-agent";
import { renderPreviewHtml } from "@/lib/ai/preview-renderer";
import { serializePublicError, toPublicError } from "@/lib/ai/scrape-errors";
import { captureAssets } from "@/lib/ai/asset-capture";
import { publicAssetUrl } from "@/lib/storage/bucket";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * scrapePreview — the wow-preview worker for the pre-auth `/preview` flow.
 *
 * Steps:
 *
 *   1. mark-running       — stamp started_at, status='running'
 *   2. scrape ($$)        — fetch + extract + 2 parallel LLM passes
 *                           (content markdown + design analysis). Persists
 *                           the deterministic extract too so debug surfaces
 *                           can audit later.
 *   3. capture-assets ($) — download logo / favicon / OG image to Supabase
 *                           Storage so the generated preview doesn't depend
 *                           on the source CDN staying alive. Per-asset
 *                           best-effort: failures here don't fail the job.
 *   4. render ($)         — third LLM call that turns the scrape output
 *                           into a self-contained HTML document the iframe
 *                           shows via `srcDoc`. Now receives the captured
 *                           asset URLs (favicon, logo) so the rendered
 *                           HTML references our cached copies.
 *   5. mark-succeeded     — write generated_html + usage + finished_at.
 *
 * Errors per step: caught at the run-level so the row gets status='failed'
 * + the actual error message (the user sees it via getPreviewStatus poll).
 * `retries: 0` matches generate-page — failures here are usually deterministic
 * (bad URL, scrape-agent rejected the site) and retries waste tokens.
 *
 * Service-role bypass: this whole function operates outside any tenant
 * scope (the row has no tenant_id by design). createAdminClient() is the
 * correct knife.
 */
export const scrapePreview = inngest.createFunction(
  {
    id: "scrape-preview",
    retries: 0,
  },
  { event: "preview/scrape.requested" },
  async ({ event, step }) => {
    const { previewId, url } = event.data as { previewId: string; url: string };

    try {
      await step.run("mark-running", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("anonymous_previews")
          .update({
            status: "running",
            started_at: new Date().toISOString(),
          })
          .eq("id", previewId);
        if (error) throw new Error(`mark-running update failed: ${error.message}`);
      });

      const scrape = await step.run("scrape", async () => {
        return runScrapeAgent({ url });
      });

      await step.run("save-scrape-output", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("anonymous_previews")
          .update({
            final_url: scrape.url,
            content_markdown: scrape.contentMarkdown,
            design: scrape.design,
            extract: scrape.extract,
            byte_size: scrape.byteSize,
          })
          .eq("id", previewId);
        if (error)
          throw new Error(`save-scrape-output update failed: ${error.message}`);
      });

      const assets = await step.run("capture-assets", async () => {
        // Best-effort. Any per-asset failure produces `null` paths; we
        // don't fail the job. Failures are logged inside captureAssets's
        // returned `failures` map.
        const captureResult = await captureAssets(
          {
            logo: scrape.design.logo.src,
            favicon: scrape.extract.faviconUrl,
            ogImage: scrape.extract.socialImage,
          },
          { pathPrefix: `previews/${previewId}` },
        );
        if (Object.keys(captureResult.failures).length > 0) {
          console.warn(
            `[scrapePreview ${previewId}] asset capture partial:`,
            captureResult.failures,
          );
        }
        // Persist the storage paths so promote-on-signup can move the
        // files and render-time consumers can build public URLs.
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("anonymous_previews")
          .update({
            logo_storage_path: captureResult.logoPath,
            favicon_storage_path: captureResult.faviconPath,
            og_image_storage_path: captureResult.ogImagePath,
          })
          .eq("id", previewId);
        if (error) {
          throw new Error(
            `save-asset-paths update failed: ${error.message}`,
          );
        }
        return captureResult;
      });

      const render = await step.run("render", async () => {
        // Swap the AI-classified logo URL for our cached storage URL so
        // the rendered HTML survives the source CDN going down. Favicon
        // and OG image follow the same pattern.
        const scrapeWithCachedAssets = {
          ...scrape,
          design: {
            ...scrape.design,
            logo: {
              ...scrape.design.logo,
              src: publicAssetUrl(assets.logoPath) ?? scrape.design.logo.src,
            },
          },
          extract: {
            ...scrape.extract,
            faviconUrl:
              publicAssetUrl(assets.faviconPath) ?? scrape.extract.faviconUrl,
            socialImage:
              publicAssetUrl(assets.ogImagePath) ?? scrape.extract.socialImage,
          },
        };
        return renderPreviewHtml(scrapeWithCachedAssets);
      });

      await step.run("mark-succeeded", async () => {
        const supabase = createAdminClient();
        // Per-pass `model` folded into the usage blob so a future cost
        // audit can attribute tokens to the model that produced them. Once
        // per-task env overrides start splitting content/design off Sonnet
        // (step 3 of the refocus plan in docs/ai-prompt-modes.md §10.0),
        // these fields stop being redundant and start being load-bearing.
        const totalUsage = {
          content: { ...scrape.usage.content, model: scrape.models.content },
          design: { ...scrape.usage.design, model: scrape.models.design },
          render: { ...render.usage, model: render.model },
        };
        const { error } = await supabase
          .from("anonymous_previews")
          .update({
            status: "succeeded",
            generated_html: render.html,
            model: render.model,
            usage: totalUsage,
            finished_at: new Date().toISOString(),
          })
          .eq("id", previewId);
        if (error)
          throw new Error(`mark-succeeded update failed: ${error.message}`);
      });
    } catch (err) {
      // Persist a public-safe error string to the row (code|message format).
      // The raw cause goes to Inngest's logs via the rethrow — internal
      // detail stays out of the public response.
      //
      // If THIS write fails, the function still rejects to Inngest and the
      // dev UI will surface it, but the user-facing UI will see the row
      // stuck on 'running' — a separate "stuck-job sweeper" is post-MVP.
      const publicErr = toPublicError(err);
      const internalMessage =
        err instanceof Error ? err.message : String(err);
      try {
        const supabase = createAdminClient();
        await supabase
          .from("anonymous_previews")
          .update({
            status: "failed",
            error: serializePublicError(publicErr),
            finished_at: new Date().toISOString(),
          })
          .eq("id", previewId);
      } catch {
        // Swallow the secondary error so the original throws through to
        // Inngest unmodified.
      }
      // Log the raw cause server-side for debugging; not surfaced publicly.
      console.error(
        `[scrapePreview ${previewId}] failed with public_code=${publicErr.code}, raw:`,
        internalMessage,
      );
      throw err;
    }
  },
);
