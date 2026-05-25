import "server-only";
import { inngest } from "../client";
import { runScrapeAgent } from "@/lib/ai/scrape-agent";
import { renderPreviewHtml } from "@/lib/ai/preview-renderer";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RenderIntent } from "@/lib/ai/render-prompts";
import {
  loadJabCredentials,
  createJabMcpClient,
  resolveFrontPage,
  getPageBySlug,
  type ConnectedSiteData,
} from "@/lib/jab/ability-client";

/**
 * regenerateHomepage — post-onboarding worker.
 *
 * Triggered at the end of `completeOnboardingAction` (and from the
 * workspace's manual "Regenerate" button). Re-runs the public-homepage
 * scrape pipeline against the connected WP URL and re-renders the
 * preview HTML with the user's *intent* (faithful / refresh / reimagine)
 * baked into the prompt as a treatment directive — the directive lives
 * in `lib/ai/render-prompts.ts` (`INTENT_BRIEFS`).
 *
 * Why this exists: the wow-preview HTML carried over from the
 * pre-signup `anonymous_previews` row is a snapshot from before the
 * user committed to an intent. The intent picker at step 0 of the
 * wizard was a dead control until this worker existed — selecting
 * "Reimagine" produced the same preview as "Faithful." Now it doesn't.
 *
 * Steps:
 *   1. mark-generating — flip `preview_html_status` so the workspace
 *                        renders the "regenerating" panel instead of
 *                        the now-stale iframe.
 *   2. read-row        — fetch the columns we need (wp_url, intent,
 *                        tenant_id). Keeps the dispatched payload thin
 *                        — events carry only IDs.
 *   3. scrape ($$)     — re-runs scrape-agent (content + design two-pass)
 *                        against the WP homepage. Same pipeline as
 *                        extractProjectDesign, separate run so a homepage
 *                        update between connect-time and finish-onboarding
 *                        gets reflected.
 *   4. fetch-connected — best-effort: pull the front-page slug from WP
 *                        settings, then call `jab/get-page-by-slug` for
 *                        v0.6.0 typed BlockNode[] ground truth. Failures
 *                        degrade to null — the render still proceeds with
 *                        public-HTML data only.
 *   5. render ($)      — calls renderPreviewHtml with intent + connected.
 *                        Output is the new self-contained HTML document.
 *   6. mark-ready      — write preview_html + flip status to 'ready'.
 *
 * Failure handling: any step throw flips `preview_html_status='failed'`
 * and preserves the previous preview_html. The workspace surfaces a
 * "Regeneration failed — retry?" panel referencing this state. Inngest's
 * dev/cloud UI carries the actual stack.
 *
 * `retries: 0` matches the rest of the workers in this directory —
 * failures are deterministic (LLM rejected the prompt, scrape blocked,
 * model returned non-HTML) and silently retrying eats tokens.
 *
 * Idempotency: re-running this worker overwrites preview_html every
 * time. A user clicking "Regenerate" twice gets the second worker's
 * output. We don't dedupe by recent-completion timestamp because the
 * user might legitimately want the second take (LLM output varies).
 *
 * Future work — Layer 2: enrich the prompt with authenticated content
 * pulled via the WP REST API + the stored app password (recent posts,
 * ACF field groups, menus visible only to authenticated users). This
 * worker accepts that augmentation as a follow-up — its public
 * boundary (event shape, status column transitions) stays stable.
 */
export const regenerateHomepage = inngest.createFunction(
  {
    id: "regenerate-homepage",
    retries: 0,
  },
  { event: "project/homepage.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId } = event.data as {
      projectId: string;
      tenantId: string;
    };

    // ─── Step 1 — mark generating ───────────────────────────────────
    await step.run("mark-generating", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("projects")
        .update({ preview_html_status: "generating" })
        .eq("id", projectId)
        .eq("tenant_id", tenantId);
      if (error)
        throw new Error(`mark-generating failed: ${error.message}`);
    });

    // The mark-failed wrapper around the remaining steps. If any of
    // them throw, we record 'failed' on the row before re-throwing so
    // the workspace can render the retry affordance. The previous
    // preview_html is left in place — losing the user's visible state
    // on a transient regen failure would be worse than carrying a
    // slightly-stale preview.
    try {
      // ─── Step 2 — read row ────────────────────────────────────────
      const row = await step.run("read-row", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("projects")
          .select("wp_url, intent")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single();
        if (error) throw new Error(`read-row failed: ${error.message}`);
        if (!data?.wp_url) throw new Error("project has no wp_url");
        return {
          wpUrl: data.wp_url as string,
          intent: (data.intent as RenderIntent | null) ?? null,
        };
      });

      // ─── Step 3 — scrape ──────────────────────────────────────────
      const scrape = await step.run("scrape", async () => {
        return runScrapeAgent({
          url: row.wpUrl,
          label: `regenerateHomepage ${projectId}`,
        });
      });

      // ─── Step 4 — fetch connected structured data (best-effort) ───
      // Pulls the front-page slug from WP settings, then calls the v0.6.0
      // `jab/get-page-by-slug` ability to get typed BlockNode[] ground
      // truth for the renderer. Eliminates section-sequence guessing for
      // Tier-1 sites (per docs/ai-prompt-modes.md §3.5 + step 6 of §10.0).
      //
      // Fail-soft: any failure (missing creds, expired app password, WP
      // misconfigured, ability unavailable) returns null, and the render
      // step proceeds with public-HTML data only. The connected fetch is
      // a fidelity upgrade, not a correctness gate — losing it shouldn't
      // fail an otherwise-valid regen.
      //
      // Internal try/catch is the whole point: throwing from inside
      // step.run would trip the function-level mark-failed wrapper, and
      // we want degraded-success here, not user-visible failure.
      const connected = await step.run("fetch-connected", async (): Promise<ConnectedSiteData | null> => {
        try {
          const creds = await loadJabCredentials(projectId, tenantId);
          const frontPage = await resolveFrontPage(creds);
          if (!frontPage) {
            return null;
          }
          const client = createJabMcpClient(creds);
          const page = await getPageBySlug(client, frontPage.slug);
          if (!page) {
            return null;
          }
          return {
            frontPage,
            blocks: page.blocks ?? [],
            content: page.content ?? "",
          };
        } catch (err) {
          console.warn(
            `[regenerateHomepage ${projectId}] connected fetch failed; degrading to public-HTML only:`,
            err instanceof Error ? err.message : String(err),
          );
          return null;
        }
      });

      // ─── Step 5 — render with intent + connected (when available) ─
      const rendered = await step.run("render", async () => {
        const intent = row.intent ?? undefined;
        return renderPreviewHtml(scrape, { intent, connected });
      });

      // ─── Step 6 — mark ready + persist HTML + usage telemetry ─────
      // Per-pass usage + model is folded into a single `usage` column
      // mirroring `anonymous_previews.usage` so a cost audit can ask
      // "what fraction of authenticated regens fell back from Haiku to
      // Sonnet?" via SQL against `projects.usage->'content'->>'model'`.
      // Before migration 0013 this data only lived in Inngest logs.
      await step.run("mark-ready", async () => {
        const supabase = createAdminClient();
        const usage = {
          content: { ...scrape.usage.content, model: scrape.models.content },
          design: { ...scrape.usage.design, model: scrape.models.design },
          render: { ...rendered.usage, model: rendered.model },
        };
        const { data: updated, error } = await supabase
          .from("projects")
          .update({
            preview_html: rendered.html,
            preview_html_status: "ready",
            usage,
          })
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .select("id");
        if (error)
          throw new Error(`mark-ready failed: ${error.message}`);
        if (!updated || updated.length === 0)
          throw new Error(
            `mark-ready no-op — project ${projectId} / tenant ${tenantId} not found`,
          );
      });
    } catch (workerErr) {
      // Best-effort transition to 'failed'. If even this fails (very
      // unusual — would mean Supabase itself is down), Inngest still
      // surfaces the original error in its trace. We rethrow so the
      // Inngest UI flags the run.
      try {
        const supabase = createAdminClient();
        await supabase
          .from("projects")
          .update({ preview_html_status: "failed" })
          .eq("id", projectId)
          .eq("tenant_id", tenantId);
      } catch (markFailedErr) {
        console.error(
          `[regenerateHomepage ${projectId}] mark-failed also failed:`,
          markFailedErr instanceof Error ? markFailedErr.message : String(markFailedErr),
        );
      }
      throw workerErr;
    }
  },
);
