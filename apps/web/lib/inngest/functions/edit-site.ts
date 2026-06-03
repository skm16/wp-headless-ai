import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { markBuildFailed } from "@/lib/inngest/shared-failure";
import { isUniqueViolation } from "@/lib/jab/postgres-errors";

/**
 * edit-site — Phase 7 of the 2026-06-02 SaaS-app completion plan.
 *
 * Triggered by `site/edit.requested` from requestWorkspaceEditAction.
 *
 * v1 scope (internal pilot):
 *   - Clone block_inventory + page_inventory rows from source to new build.
 *   - Clone the source build's components/ + source/ Storage prefixes.
 *   - Dispatch site/compose.requested for the new build → compose → deploy
 *     → verify runs autonomously.
 *   - workspace_edits.result_build_id points at the new build for the UI.
 *
 * Deferred to a Phase 7.1 follow-up:
 *   - Guidance-driven regeneration of the targeted component/shell.
 *     Today the worker honors the workspace_edits row's scope/target/prompt
 *     by persisting them on the new site_builds.config, so the follow-up
 *     can read them and slot regeneration in between clone and dispatch.
 *
 * Notes:
 *   - retries: 0 — same posture as the other workers; recovery is a fresh
 *     site/edit.requested dispatch.
 *   - On any throw, both workspace_edits and the new site_builds row are
 *     marked failed with markBuildFailed (the worker's catch).
 */

export const editSite = inngest.createFunction(
  { id: "edit-site", retries: 0 },
  { event: "site/edit.requested" },
  async ({ event, step }) => {
    const {
      editId,
      projectId,
      tenantId,
      sourceBuildId,
      scope,
      target,
      prompt,
    } = event.data as {
      editId: string;
      projectId: string;
      tenantId: string;
      sourceBuildId: string;
      scope: "component" | "shell" | "page";
      target: string;
      prompt: string;
    };

    let resultBuildId: string | null = null;
    try {
      await step.run("mark-edit-running", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("workspace_edits")
          .update({ status: "running" })
          .eq("id", editId);
        if (error) throw new Error(`edit-site: mark-running update failed: ${error.message}`);
      });

      resultBuildId = await step.run("create-result-build", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("site_builds")
          .insert({
            project_id: projectId,
            status: "queued",
            config: {
              mode: "edit",
              source_build_id: sourceBuildId,
              scope,
              target,
              prompt,
            },
          })
          .select("id")
          .single<{ id: string }>();
        if (error || !data) {
          // The site_builds_active_project_idx partial unique index
          // (migration 0025) refuses a second active build per project.
          // An edit issued while another build is in flight trips 23505 —
          // surface a clear reason; the outer catch marks workspace_edits
          // failed with this message.
          if (isUniqueViolation(error)) {
            throw new Error(
              `edit-site: create-result-build refused — another active build already exists for project ${projectId} (site_builds_active_project_idx). Wait for it to finish or fail before re-issuing the edit.`,
            );
          }
          throw new Error(`edit-site: create-result-build failed: ${error?.message ?? "no row"}`);
        }
        return data.id;
      });

      await step.run("link-edit-row", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("workspace_edits")
          .update({ result_build_id: resultBuildId })
          .eq("id", editId);
        if (error) throw new Error(`edit-site: link-edit-row update failed: ${error.message}`);
      });

      // Wave 1: clone block_inventory rows.
      const blocksCloned = await step.run("clone-block-inventory", async () => {
        const supabase = createAdminClient();
        const { data: src, error: readErr } = await supabase
          .from("block_inventory")
          .select(
            "block_name, occurrence_count, page_slugs, attr_samples, computed_styles, source_dom_sample, tier, model_used, provider_used, input_tokens_cached, input_tokens_uncached, output_tokens, compile_status, compile_attempt_count, kind, spec",
          )
          .eq("site_build_id", sourceBuildId)
          .eq("project_id", projectId);
        if (readErr) throw new Error(`edit-site: read block_inventory failed: ${readErr.message}`);
        const rows = (src ?? []).map((r) => ({
          ...r,
          site_build_id: resultBuildId!,
          project_id: projectId,
        }));
        if (rows.length === 0) return 0;
        const { error: insertErr } = await supabase
          .from("block_inventory")
          .insert(rows);
        if (insertErr) throw new Error(`edit-site: insert block_inventory failed: ${insertErr.message}`);
        return rows.length;
      });

      // Wave 2: clone page_inventory rows.
      const pagesCloned = await step.run("clone-page-inventory", async () => {
        const supabase = createAdminClient();
        const { data: src, error: readErr } = await supabase
          .from("page_inventory")
          .select(
            "slug, post_type, title, route_path, block_count, source_screenshot_paths, rendering, paradigms",
          )
          .eq("site_build_id", sourceBuildId)
          .eq("project_id", projectId);
        if (readErr) throw new Error(`edit-site: read page_inventory failed: ${readErr.message}`);
        const rows = (src ?? []).map((r) => ({
          ...r,
          site_build_id: resultBuildId!,
          project_id: projectId,
        }));
        if (rows.length === 0) return 0;
        const { error: insertErr } = await supabase
          .from("page_inventory")
          .insert(rows);
        if (insertErr) throw new Error(`edit-site: insert page_inventory failed: ${insertErr.message}`);
        return rows.length;
      });

      // Wave 3: copy components/ and source/ prefixes from source build to
      // new build. Storage's `copy` requires per-object calls — list then
      // copy. components/ holds the Phase B output that compose downloads;
      // source/ holds Phase A screenshots that verify needs.
      const storageCopied = await step.run("clone-storage-artifacts", async () => {
        const supabase = createAdminClient();
        let copied = 0;
        for (const prefix of ["components", "source"]) {
          const list = await listAllUnderPrefix(
            supabase,
            `builds/${sourceBuildId}/${prefix}`,
          );
          for (const path of list) {
            const newPath = path.replace(
              `builds/${sourceBuildId}/`,
              `builds/${resultBuildId}/`,
            );
            const { error } = await supabase.storage
              .from(SITE_SCREENSHOTS_BUCKET)
              .copy(path, newPath);
            if (error) {
              // Tolerate a single-file copy failure; record but continue
              // so a transient Storage hiccup doesn't tank the whole edit.
              console.warn(
                `[edit-site] storage copy failed for ${path} → ${newPath}: ${error.message}`,
              );
              continue;
            }
            copied++;
          }
        }
        return copied;
      });

      console.log(
        `[edit-site] cloned: ${blocksCloned} block_inventory rows, ${pagesCloned} page_inventory rows, ${storageCopied} storage objects`,
      );

      // Dispatch compose to run the rest of the pipeline against the new
      // build. The result-build row already has status='queued'; compose
      // flips it to 'composing' and the chain runs autonomously.
      //
      // Phase 7.1 will slot the regeneration step in BEFORE this dispatch:
      //   - scope='component': re-run generateComponent with guidance
      //     for the targeted block_name, overwriting the cloned tsx.
      //   - scope='shell': re-run generateShell for the targeted kind.
      await step.sendEvent("dispatch-compose", {
        name: "site/compose.requested",
        data: {
          projectId,
          tenantId,
          buildId: resultBuildId!,
        },
      });

      await step.run("mark-edit-completed", async () => {
        const supabase = createAdminClient();
        const { error } = await supabase
          .from("workspace_edits")
          .update({
            status: "completed",
            finished_at: new Date().toISOString(),
          })
          .eq("id", editId);
        if (error) throw new Error(`edit-site: mark-completed update failed: ${error.message}`);
      });

      return {
        editId,
        resultBuildId,
        blocksCloned,
        pagesCloned,
        storageCopied,
      };
    } catch (err) {
      // Mark BOTH the workspace edit row AND the result build row failed.
      const errorText = err instanceof Error ? err.message : String(err);
      const supabase = createAdminClient();
      await supabase
        .from("workspace_edits")
        .update({
          status: "failed",
          error_text: errorText,
          finished_at: new Date().toISOString(),
        })
        .eq("id", editId);
      if (resultBuildId) {
        await markBuildFailed({
          buildId: resultBuildId,
          projectId,
          phase: "components",
          error: err,
        });
      }
      throw err;
    }
  },
);

/**
 * Recursively list every object under a Storage prefix. supabase.storage
 * .list() is paginated and one-level-deep — we descend into directories
 * manually because the components/ and source/ prefixes have nested
 * viewport folders.
 */
async function listAllUnderPrefix(
  supabase: ReturnType<typeof createAdminClient>,
  prefix: string,
): Promise<string[]> {
  const queue: string[] = [prefix];
  const out: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const { data, error } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .list(current, { limit: 1000 });
    if (error || !data) continue;
    for (const item of data) {
      // Folders surface as entries with id===null in Supabase Storage.
      if (item.id === null) {
        queue.push(`${current}/${item.name}`);
      } else {
        out.push(`${current}/${item.name}`);
      }
    }
  }
  return out;
}
