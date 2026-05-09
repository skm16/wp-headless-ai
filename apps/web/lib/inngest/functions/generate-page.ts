import "server-only";
import { inngest } from "../client";
import { generatePageCode } from "@/lib/ai/agent";
import { loadPageContext } from "@/lib/jab/page-context";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * generatePage — the AI page-generation worker.
 *
 * Three steps after Phase D Chunk B:
 *   1. mark-running — stamp generation_jobs.started_at, status='running'
 *   2. load-context — read project + decrypt creds + emit SDK + fetch DOM
 *   3. call-agent  — one-shot Claude Messages API with prompt caching
 *      (SDK source goes in the cached system block; subsequent generations
 *      against the same project skip ~95% of input tokens).
 *
 * On success, the generated_code + token usage land in the row and status
 * flips to 'succeeded'. Chunk C will append a fourth step (push-to-github)
 * that promotes the code from the DB to a feature branch on the agency's
 * repo.
 *
 * Error handling: any throw inside a step.run propagates to the Inngest
 * runtime, which surfaces it in the dev UI and (with retries: 0) marks
 * the function failed. We catch the run-level error to write the message
 * to generation_jobs.error so the SaaS UI can show it without the user
 * having to open Inngest Cloud.
 */
export const generatePage = inngest.createFunction(
  {
    id: "generate-page",
    retries: 0,
  },
  { event: "project/generate.requested" },
  async ({ event, step }) => {
    const { projectId, jobId, pagePath } = event.data as {
      projectId: string;
      jobId: string;
      pagePath: string;
    };

    try {
      await step.run("mark-running", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("generation_jobs")
          .update({
            status: "running",
            started_at: new Date().toISOString(),
          })
          .eq("id", jobId);
        if (error) throw new Error(`mark-running update failed: ${error.message}`);
      });

      const context = await step.run("load-context", async () => {
        const ctx = await loadPageContext(projectId, pagePath);
        return {
          wpUrl: ctx.wpUrl,
          pageUrl: ctx.pageUrl,
          pagePath: ctx.pagePath,
          pageHtml: ctx.pageHtml,
          abilitiesSummary: ctx.abilitiesSummary,
          sdkSource: ctx.sdkSource,
        };
      });

      const generation = await step.run("call-agent", async () => {
        return generatePageCode(context);
      });

      await step.run("mark-succeeded", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("generation_jobs")
          .update({
            status: "succeeded",
            finished_at: new Date().toISOString(),
            model: generation.model,
            input_tokens: generation.usage.input_tokens,
            output_tokens: generation.usage.output_tokens,
            cache_read_tokens: generation.usage.cache_read_input_tokens ?? 0,
            cache_creation_tokens:
              generation.usage.cache_creation_input_tokens ?? 0,
            output_path: "app/page.tsx",
            generated_code: generation.code,
          })
          .eq("id", jobId);
        if (error) throw new Error(`mark-succeeded update failed: ${error.message}`);
      });

      return {
        jobId,
        projectId,
        inputTokens: generation.usage.input_tokens,
        outputTokens: generation.usage.output_tokens,
        cacheReadTokens: generation.usage.cache_read_input_tokens ?? 0,
        codeChars: generation.code.length,
      };
    } catch (err) {
      // Best-effort: persist the error message to the job row so the UI
      // can show it. If THIS write fails too, Inngest still has the error
      // in its dev UI.
      const message = err instanceof Error ? err.message : String(err);
      try {
        const supabase = createAdminClient();
        await supabase
          .from("generation_jobs")
          .update({
            status: "failed",
            error: message,
            finished_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      } catch {
        // swallow — original error is more important
      }
      throw err;
    }
  },
);
