import "server-only";
import { inngest } from "../client";
import { runScrapeAgent } from "@/lib/ai/scrape-agent";
import { renderPreviewHtml } from "@/lib/ai/preview-renderer";
import { serializePublicError, toPublicError } from "@/lib/ai/scrape-errors";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * scrapePreview — the wow-preview worker.
 *
 * Three meaningful steps, mirroring the generate-page pattern but for the
 * pre-auth `/preview` flow:
 *
 *   1. mark-running   — stamp started_at, status='running'
 *   2. scrape ($$)    — fetch + extract + 2 parallel LLM passes (content
 *                       markdown + design analysis). Persists the
 *                       deterministic extract too so debug surfaces can
 *                       audit later.
 *   3. render ($)     — third LLM call that turns the scrape output into
 *                       a self-contained HTML document the iframe shows
 *                       via `srcDoc`.
 *   4. mark-succeeded — write generated_html + usage + finished_at.
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

      const render = await step.run("render", async () => {
        return renderPreviewHtml(scrape);
      });

      await step.run("mark-succeeded", async () => {
        const supabase = createAdminClient();
        const totalUsage = {
          content: scrape.usage.content,
          design: scrape.usage.design,
          render: render.usage,
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
