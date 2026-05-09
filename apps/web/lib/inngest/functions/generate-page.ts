import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * generatePage — the AI page-generation worker.
 *
 * Phase D builds this in three chunks:
 *   Chunk A (this file, current state): skeleton — receives event, marks the
 *     generation_jobs row 'running', then 'failed' with a "not implemented"
 *     error. Proves the queue + DB write boundary works.
 *   Chunk B (next): loads project context, decrypts WP creds, fetches DOM,
 *     calls Claude with prompt caching, stores generated_code on the row.
 *   Chunk C (last): clones the agency's GitHub repo, commits the file on a
 *     feature branch, pushes, stores branch + commit_sha on the row.
 *
 * Event shape (sent from /api/projects/[id]/generate):
 *   { name: "project/generate.requested",
 *     data: { projectId: uuid, jobId: uuid, pagePath: string } }
 *
 * Worker uses service-role Supabase (bypasses RLS) — the user-scope check
 * lives in the API route that *creates* the job. Once the event fires the
 * worker trusts the jobId is for a row the user is allowed to write to.
 */
export const generatePage = inngest.createFunction(
  {
    id: "generate-page",
    // Page generation is expensive and side-effecting (GitHub push). Surface
    // failures early; user can re-trigger from the UI if they want a retry.
    retries: 0,
  },
  { event: "project/generate.requested" },
  async ({ event, step }) => {
    const { projectId, jobId, pagePath } = event.data as {
      projectId: string;
      jobId: string;
      pagePath: string;
    };

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

    // -------- Chunk B will land here: AI call ----------------------------
    // -------- Chunk C will land here: GitHub push ------------------------

    await step.run("mark-stub-complete", async () => {
      const supabase = createAdminClient();
      await supabase
        .from("generation_jobs")
        .update({
          status: "failed",
          error:
            "Phase D Chunk A skeleton: function reached but AI + GitHub steps not yet implemented.",
          finished_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    });

    return { projectId, jobId, pagePath };
  },
);
