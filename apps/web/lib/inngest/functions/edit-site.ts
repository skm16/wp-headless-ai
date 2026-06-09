import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { markBuildFailed } from "@/lib/inngest/shared-failure";
import { EDIT_REQUESTED_EVENT, type SiteEditRequestedData } from "@/lib/inngest/edit-request-event";
import { carryForwardSourceConfig, type BuildConfig } from "@/lib/jab/build-config";
import { regenerateComponentUnit, regenerateShellUnit, RegenCompileError } from "@/lib/jab/regenerate-unit";
import { computeChangedPages } from "@/lib/jab/edit-impact";
import { loadSourcePagesForImpact, PAGE_INVENTORY_CLONE_COLUMNS } from "@/lib/inngest/functions/edit-site.helpers";

/**
 * edit-site — Phase 7 of the 2026-06-02 SaaS-app completion plan.
 *
 * Triggered by `site/edit.requested` from requestWorkspaceEditAction.
 *
 * v1 scope (internal pilot):
 *   - Clone block_inventory + page_inventory rows from source to new build.
 *   - Clone the source build's components/ + source/ Storage prefixes.
 *   - Regenerate the targeted unit (component or shell) with guidance.
 *   - Compute the changed-page set via diff against the source block_tree.
 *   - Dispatch site/compose.requested for the new build → compose → deploy
 *     → verify runs autonomously.
 *   - workspace_edits.result_build_id points at the new build for the UI.
 *
 * Notes:
 *   - retries: 0 — same posture as the other workers; recovery is a fresh
 *     site/edit.requested dispatch.
 *   - On any failure, the abort path / catch sets workspace_edits.status='failed'
 *     directly, then markBuildFailed marks the site_builds row failed. (markBuildFailed
 *     does not cascade to the edit row, so each failure writer sets it explicitly.)
 */

export const editSite = inngest.createFunction(
  { id: "edit-site", retries: 0 },
  { event: EDIT_REQUESTED_EVENT },
  async ({ event, step }) => {
    const {
      editId,
      projectId,
      tenantId,
      sourceBuildId,
      scope,
      target,
      prompt,
      regenerationPrompt,
      action,
      messageId,
    } = event.data as SiteEditRequestedData;
    // Manual-form path omits regenerationPrompt → fall back to the raw prompt.
    const guidance = (regenerationPrompt ?? prompt ?? "").trim();
    const planAction = action ?? `Edited ${scope} '${target}'`;

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
        // Read the SOURCE build's config: front_page_slug lives there (legacy
        // untyped key on full builds / typed field on edit builds). Without
        // carrying it, compose-site's front-page resolution throws for every
        // edit build (the route_path='/' fallback is dead — see build-config.ts).
        const { data: sourceRow, error: sourceErr } = await supabase
          .from("site_builds")
          .select("config")
          .eq("id", sourceBuildId)
          .eq("project_id", projectId)
          .single<{ config: unknown }>();
        if (sourceErr || !sourceRow) {
          throw new Error(
            `edit-site: source build ${sourceBuildId} config read failed: ${sourceErr?.message ?? "no row"}`,
          );
        }
        const carried = carryForwardSourceConfig(sourceRow.config);
        const config: BuildConfig = {
          mode: "edit",
          source_build_id: sourceBuildId,
          scope,
          target,
          prompt,
          regeneration_prompt: guidance,
          action: planAction,
          edit_id: editId,
          message_id: messageId ?? null,
          changed_slugs: [],
          change_reason: null,
          front_page_slug: carried.front_page_slug,
          ...(carried.last_sync_watermark !== undefined
            ? { last_sync_watermark: carried.last_sync_watermark }
            : {}),
        };
        const { data, error } = await supabase
          .from("site_builds")
          .insert({ project_id: projectId, status: "queued", config })
          .select("id")
          .single<{ id: string }>();
        if (error || !data) {
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
        // Backfill the chat message that triggered this edit so the chat card
        // can link to the result build's preview/review. messageId is null on
        // the manual-form path — skip the backfill there.
        if (messageId) {
          await supabase
            .from("chat_messages")
            .update({ build_id: resultBuildId, edit_id: editId })
            .eq("id", messageId);
        }
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
          .select(PAGE_INVENTORY_CLONE_COLUMNS)
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

      // ── Regenerate the targeted unit (sole owner of the regen seam). ──
      // Component scope: re-run generateComponent with guidance, overwriting the
      // cloned tsx. Shell scope: a no-op here — compose's generate-header/footer
      // read config.regeneration_prompt (avoids double-generation).
      const regenOutcome = await step.run("regenerate-target", async () => {
        try {
          if (scope === "shell") {
            void regenerateShellUnit(target); // guard-throws if target is not 'header'|'footer'
            return { ok: true as const, kind: "shell" as const };
          }
          // Component scope. Anchor the visual-tier screenshot on the front/home
          // slug; loadHomeOrSlugScreenshotBase64 fails soft when absent.
          // A hard DB error here is caught below and permanently fails the edit
          // (retries: 0 — recovery is a fresh site/edit.requested dispatch).
          const supabase = createAdminClient();
          const { data: front } = await supabase
            .from("page_inventory")
            .select("slug")
            .eq("site_build_id", resultBuildId!)
            .eq("route_path", "/")
            .maybeSingle<{ slug: string }>();
          const screenshotSlug = front?.slug ?? "home";
          const result = await regenerateComponentUnit({
            buildId: resultBuildId!,
            projectId,
            target,
            guidance,
            screenshotSlug,
          });
          return { ok: true as const, kind: "component" as const, compileStatus: result.compileStatus };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const isCompile = err instanceof RegenCompileError;
          return { ok: false as const, isCompile, message };
        }
      });

      if (!regenOutcome.ok) {
        // Hard stop: mark edit + result build failed, surface to chat, do NOT
        // dispatch compose (no broken/no-op preview).
        await step.run("abort-on-regen-fail", async () => {
          const supabase = createAdminClient();
          await supabase
            .from("workspace_edits")
            .update({
              status: "failed",
              error_text: `regeneration failed: ${regenOutcome.message}`,
              finished_at: new Date().toISOString(),
            })
            .eq("id", editId);
          if (messageId) {
            await supabase
              .from("chat_messages")
              .update({ content: `That edit couldn't be applied: ${regenOutcome.message}` })
              .eq("id", messageId);
          }
        });
        await markBuildFailed({ buildId: resultBuildId!, projectId, phase: "components", error: new Error(regenOutcome.message) });
        return { editId, resultBuildId, regenFailed: true };
      }

      // ── Compute the changed-page set (pure core; SOURCE block_tree). ──
      const changed = await step.run("compute-changed-pages", async () => {
        const sourcePages = await loadSourcePagesForImpact(sourceBuildId);
        const result = computeChangedPages({ scope, target, sourcePages });
        const supabase = createAdminClient();
        await supabase
          .from("workspace_edits")
          .update({ changed_slugs: result.changedSlugs, change_reason: result.reason })
          .eq("id", editId);
        // Patch config.changed_slugs / change_reason on the result build so the
        // verify carry-forward + scoped review read them off config.
        const { data: buildRow } = await supabase
          .from("site_builds")
          .select("config")
          .eq("id", resultBuildId!)
          .single<{ config: BuildConfig }>();
        if (!buildRow || buildRow.config.mode !== "edit") {
          throw new Error(
            `edit-site: compute-changed-pages found unexpected config mode '${buildRow?.config?.mode ?? "null"}' on build ${resultBuildId}; expected 'edit'.`,
          );
        }
        const nextConfig: BuildConfig = {
          ...buildRow.config,
          changed_slugs: result.changedSlugs,
          change_reason: result.reason,
        };
        await supabase.from("site_builds").update({ config: nextConfig }).eq("id", resultBuildId!);
        return result;
      });
      console.log(`[edit-site] changed ${changed.changedSlugs.length} page(s) (reason=${changed.reason})`);

      // Dispatch compose to run the rest of the pipeline against the new
      // build. The result-build row already has status='queued'; compose
      // flips it to 'composing' and the chain runs autonomously.
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
export async function listAllUnderPrefix(
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
