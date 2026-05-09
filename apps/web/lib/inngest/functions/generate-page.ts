import "server-only";
import { inngest } from "../client";
import { generatePageCode } from "@/lib/ai/agent";
import {
  commitGeneratedFile,
  generationBranchName,
  prepareTargetRepo,
} from "@/lib/github/push";
import { loadGithubCreds, loadPageContext } from "@/lib/jab/page-context";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * generatePage — the AI page-generation worker.
 *
 * Six steps. Notable: prepare-repo runs BEFORE call-agent so any
 * GitHub-side error (bad PAT scope, deleted repo, etc.) fails the job
 * for $0 in Anthropic tokens. We pay for the AI step only after we've
 * proved we have somewhere to commit its output.
 *
 *   1. mark-running     — stamp started_at, status='running'
 *   2. load-context     — read project + decrypt WP creds + emit SDK +
 *                         fetch page DOM. Returns ONLY the AI-relevant
 *                         fields to Inngest step memo (no creds in
 *                         replay state).
 *   3. prepare-repo     — verify PAT can read the repo and either
 *                         resolve the default-branch SHA or seed an
 *                         initial commit on an empty repo. CHEAP — runs
 *                         before the expensive call.
 *   4. call-agent ($$$) — one-shot Claude Messages API with prompt
 *                         caching. SDK source goes in the cached system
 *                         block; subsequent generations against the
 *                         same project skip ~95% of input tokens within
 *                         the 5-min cache TTL.
 *   5. commit-and-push  — create jab/<page>-<job> feature branch from
 *                         the prepared baseSha, commit app/page.tsx.
 *   6. mark-succeeded   — persist generated_code, token usage, branch,
 *                         commit SHA. status='succeeded'.
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

      const prepared = await step.run("prepare-repo", async () => {
        const creds = await loadGithubCreds(projectId);
        const result = await prepareTargetRepo({
          pat: creds.pat,
          repoFullName: creds.repoFullName,
          projectName: creds.projectName,
          manifest: creds.manifest,
        });
        return {
          repoFullName: creds.repoFullName,
          baseBranch: result.baseBranch,
          baseSha: result.baseSha,
          scaffolded: result.scaffolded,
        };
      });

      const generation = await step.run("call-agent", async () => {
        return generatePageCode(context);
      });

      // Persist AI output to the DB BEFORE attempting the push. If the
      // push step fails (network blip, race on the branch name, etc.),
      // the generated code is still recoverable via SQL — we don't
      // strand $1.20 of tokens behind an Inngest UI inspection.
      await step.run("save-ai-output", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("generation_jobs")
          .update({
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
        if (error) {
          throw new Error(`save-ai-output update failed: ${error.message}`);
        }
      });

      const pushed = await step.run("commit-and-push", async () => {
        // Re-load creds inside this step rather than reading from the
        // memoized 'prepare-repo' return value — we deliberately don't
        // ship the PAT through Inngest step state.
        const creds = await loadGithubCreds(projectId);
        const branchName = generationBranchName(pagePath, jobId);
        const commitMessage = [
          `feat: AI-generated page for ${pagePath}`,
          ``,
          `Generated by Jab from ${context.wpUrl}.`,
          `Job: ${jobId}`,
          `Tokens: in=${generation.usage.input_tokens}, out=${generation.usage.output_tokens}` +
            (generation.usage.cache_read_input_tokens
              ? `, cache_read=${generation.usage.cache_read_input_tokens}`
              : ""),
        ].join("\n");
        return commitGeneratedFile({
          pat: creds.pat,
          repoFullName: prepared.repoFullName,
          baseBranch: prepared.baseBranch,
          baseSha: prepared.baseSha,
          branchName,
          filePath: "app/page.tsx",
          fileContent: generation.code,
          commitMessage,
        });
      });

      await step.run("mark-succeeded", async () => {
        // AI output + token usage already persisted by 'save-ai-output'.
        // This step just records the push outcome and flips status.
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("generation_jobs")
          .update({
            status: "succeeded",
            finished_at: new Date().toISOString(),
            output_branch: pushed.branch,
            output_commit_sha: pushed.commitSha,
          })
          .eq("id", jobId);
        if (error) throw new Error(`mark-succeeded update failed: ${error.message}`);
      });

      return {
        jobId,
        projectId,
        branch: pushed.branch,
        commitSha: pushed.commitSha,
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
