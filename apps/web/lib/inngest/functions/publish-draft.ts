import "server-only";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { markBuildFailed } from "@/lib/inngest/shared-failure";
import {
  DRAFT_PUBLISH_REQUESTED_EVENT,
  type DraftPublishRequestedData,
} from "@/lib/inngest/publish-draft-event";
import {
  loadDraftVersions,
  loadDraftSteps,
  loadActiveTokenDeltas,
} from "@/lib/db/drafts";
import { effectiveUnitVersions, unionChangedSlugs } from "@/lib/draft/state";
import { mergeTokenDeltas, applyTokenOverride } from "@/lib/jab/token-override";
import { resolveThemeTokens, type ThemeJsonTokens, type ScrapedBrandTokens } from "@/lib/jab/global-styles";
import {
  PAGE_INVENTORY_CLONE_COLUMNS,
  BLOCK_INVENTORY_CLONE_COLUMNS,
  listAllUnderPrefix,
} from "@/lib/inngest/functions/edit-site.helpers";
import {
  unitKeyToStoragePath,
  buildPublishDraftConfig,
  cloneStorageObjectsFailClosed,
} from "@/lib/inngest/functions/publish-draft.helpers";
import { buildShellStoragePath } from "@/lib/ai/persist-shell-generation";

/**
 * publish-draft — Live-Draft publish bridge worker (2026-06-18 plan, Task 4).
 *
 * Triggered by `draft/publish.requested` from publishDraftAction. Resurrects
 * the retired edit-site.ts clone model (blueprint: commit 82aa51f^), applied to
 * the FULL draft state instead of one regenerated unit:
 *
 *   1. load-draft-state — effectiveUnitVersions (component/shell overrides) +
 *      unionChangedSlugs + the merged token override (base tokens + active
 *      deltas; null when the draft has no token edits).
 *   2. stamp-config — patch the queued build's config = buildPublishDraftConfig.
 *   3. clone-block-inventory / clone-page-inventory — copy the base build's
 *      inventory rows (identical to edit-site.ts steps 4-5).
 *   4. clone-storage-artifacts — copy components/ + source/ + the two shell
 *      files from the base build (fail-soft per file, as edit-site did).
 *   5. overlay-draft-units — write each effective draft unit's patched TSX onto
 *      the cloned Storage (overwrites the cloned base file). This is the ONLY
 *      difference from edit-site's clone: instead of regenerating one unit, we
 *      overlay ALL draft-patched units. NO LLM regen — compose reads the
 *      cloned+overlaid Storage.
 *   6. dispatch-compose — send site/compose.requested; the build is 'queued',
 *      compose flips it to 'composing' and the pipeline runs autonomously
 *      (compose → deploy → verify → review → publishBuildAction).
 *
 * retries: 0 — same posture as the other workers; recovery is a fresh publish.
 * On any failure markBuildFailed marks the build failed (and, per Task 8,
 * unlocks the draft: publishing → active) so the user can retry.
 *
 * Token-commit note: the merged token override rides config.tokens (compose
 * prefers it — see resolveBuildTokens). projects.design_tokens is mutated ONLY
 * on production-publish (publishBuildAction); a failed publish never touches the
 * project's brand.
 */
export const publishDraft = inngest.createFunction(
  { id: "publish-draft", retries: 0 },
  { event: DRAFT_PUBLISH_REQUESTED_EVENT },
  async ({ event, step }) => {
    const { projectId, tenantId, draftId, buildId } =
      event.data as DraftPublishRequestedData;

    try {
      // ── 1. Resolve the FULL draft state. ──
      // effectiveUnitVersions = the component/shell TSX overrides; unionChangedSlugs
      // = the approval carry-forward blast radius; the token override is base
      // tokens (projects.design_tokens) + merged active token deltas, null when
      // the draft had no token edits (so compose falls back to the project brand).
      const draftState = await step.run("load-draft-state", async () => {
        const supabase = createAdminClient();

        // The draft row gives us the base build to clone from.
        const { data: draftRow, error: draftErr } = await supabase
          .from("drafts")
          .select("base_build_id")
          .eq("id", draftId)
          .single<{ base_build_id: string }>();
        if (draftErr || !draftRow) {
          throw new Error(
            `publish-draft: draft ${draftId} read failed: ${draftErr?.message ?? "no row"}`,
          );
        }
        const baseBuildId = draftRow.base_build_id;

        // Base build config — carried into the publish config (front_page_slug etc).
        const { data: baseBuild, error: baseErr } = await supabase
          .from("site_builds")
          .select("config")
          .eq("id", baseBuildId)
          .eq("project_id", projectId)
          .single<{ config: unknown }>();
        if (baseErr || !baseBuild) {
          throw new Error(
            `publish-draft: base build ${baseBuildId} config read failed: ${baseErr?.message ?? "no row"}`,
          );
        }

        const [versions, steps, tokenDeltas] = await Promise.all([
          loadDraftVersions(draftId),
          loadDraftSteps(draftId),
          loadActiveTokenDeltas(draftId),
        ]);

        const effective = effectiveUnitVersions(versions, steps);
        const overlayUnits = [...effective.entries()].map(([unitKey, row]) => ({
          unitKey,
          tsx: row.tsx,
        }));
        const changedSlugs = unionChangedSlugs(steps);

        // Merge the active token deltas onto the project's resolved base tokens.
        // null when there were no token edits — compose then reads
        // projects.design_tokens exactly as today (byte-identical).
        let tokens: ThemeJsonTokens | null = null;
        if (tokenDeltas.length > 0) {
          const { data: proj } = await supabase
            .from("projects")
            .select("design_tokens")
            .eq("id", projectId)
            .single<{ design_tokens: unknown }>();
          const dt = (proj?.design_tokens ?? {}) as {
            themeJson?: ThemeJsonTokens | null;
            colors?: ScrapedBrandTokens["colors"];
            typography?: ScrapedBrandTokens["typography"];
          };
          const baseTokens = resolveThemeTokens(dt.themeJson, {
            colors: dt.colors,
            typography: dt.typography,
          });
          tokens = applyTokenOverride(baseTokens, mergeTokenDeltas(tokenDeltas));
        }

        return { baseBuildId, baseConfig: baseBuild.config, overlayUnits, changedSlugs, tokens };
      });

      const { baseBuildId, baseConfig, overlayUnits, changedSlugs, tokens } = draftState;

      // ── 2. Stamp the real publish_draft config onto the queued build. ──
      await step.run("stamp-config", async () => {
        const supabase = createAdminClient();
        const config = buildPublishDraftConfig({
          draftId,
          baseBuildId,
          sourceConfig: baseConfig,
          changedSlugs,
          tokens,
        });
        const { error } = await supabase
          .from("site_builds")
          .update({ config })
          .eq("id", buildId)
          .eq("project_id", projectId);
        if (error) throw new Error(`publish-draft: stamp-config failed: ${error.message}`);
      });

      // ── 3a. Clone block_inventory rows from the base build. ──
      const blocksCloned = await step.run("clone-block-inventory", async () => {
        const supabase = createAdminClient();
        const { data: src, error: readErr } = await supabase
          .from("block_inventory")
          .select(BLOCK_INVENTORY_CLONE_COLUMNS)
          .eq("site_build_id", baseBuildId)
          .eq("project_id", projectId);
        if (readErr) throw new Error(`publish-draft: read block_inventory failed: ${readErr.message}`);
        const rows = (src ?? []).map((r) => ({
          ...r,
          site_build_id: buildId,
          project_id: projectId,
        }));
        if (rows.length === 0) return 0;
        const { error: insertErr } = await supabase.from("block_inventory").insert(rows);
        if (insertErr) throw new Error(`publish-draft: insert block_inventory failed: ${insertErr.message}`);
        return rows.length;
      });

      // ── 3b. Clone page_inventory rows from the base build. ──
      const pagesCloned = await step.run("clone-page-inventory", async () => {
        const supabase = createAdminClient();
        const { data: src, error: readErr } = await supabase
          .from("page_inventory")
          .select(PAGE_INVENTORY_CLONE_COLUMNS)
          .eq("site_build_id", baseBuildId)
          .eq("project_id", projectId);
        if (readErr) throw new Error(`publish-draft: read page_inventory failed: ${readErr.message}`);
        const rows = (src ?? []).map((r) => ({
          ...r,
          site_build_id: buildId,
          project_id: projectId,
        }));
        if (rows.length === 0) return 0;
        const { error: insertErr } = await supabase.from("page_inventory").insert(rows);
        if (insertErr) throw new Error(`publish-draft: insert page_inventory failed: ${insertErr.message}`);
        return rows.length;
      });

      // ── 4. Copy components/ + source/ + the two shell files from the base
      //       build to the new build. Storage's copy is per-object — list then
      //       copy. components/ holds the Phase B output compose downloads;
      //       source/ holds Phase A screenshots verify needs.
      //
      //       The base artifacts (components/ + source/) are FAIL-CLOSED via
      //       cloneStorageObjectsFailClosed (C3): a silently-dropped object
      //       would let verify mark the page skipped/null-score, which approval
      //       carry-forward then inherits as `approved` past the publish gate —
      //       deploying a page this build never verified. The shell files stay
      //       fail-soft (a base build may legitimately predate them; compose
      //       regenerates). ──
      const storageCopied = await step.run("clone-storage-artifacts", async () => {
        const supabase = createAdminClient();
        const copyObject = (from: string, to: string) =>
          supabase.storage.from(SITE_SCREENSHOTS_BUCKET).copy(from, to);

        // Prefix-recursive clones (components/, source/) — fail-closed.
        const basePaths: string[] = [];
        for (const prefix of ["components", "source"]) {
          basePaths.push(...(await listAllUnderPrefix(supabase, `builds/${baseBuildId}/${prefix}`)));
        }
        const baseCopied = await cloneStorageObjectsFailClosed(
          basePaths,
          baseBuildId,
          buildId,
          copyObject,
        );

        // Shell files (single objects under project/components/site) — fail-soft.
        let shellCopied = 0;
        for (const kind of ["header", "footer"] as const) {
          const fromPath = buildShellStoragePath(baseBuildId, kind);
          const toPath = buildShellStoragePath(buildId, kind);
          const { error } = await copyObject(fromPath, toPath);
          if (error) {
            // Tolerate a missing shell (a base build that predates the shell
            // artifact) — the overlay or compose regenerates it.
            console.warn(`[publish-draft] shell copy failed for ${fromPath} → ${toPath}: ${error.message}`);
            continue;
          }
          shellCopied++;
        }
        return baseCopied + shellCopied;
      });

      console.log(
        `[publish-draft] cloned: ${blocksCloned} block_inventory rows, ${pagesCloned} page_inventory rows, ${storageCopied} storage objects`,
      );

      // ── 5. Overlay each effective draft unit's patched TSX onto the cloned
      //       Storage (overwrites the cloned base file). This is the sole
      //       difference from edit-site's clone: instead of regenerating one
      //       unit with the LLM, we write ALL draft-patched units verbatim. ──
      const overlaid = await step.run("overlay-draft-units", async () => {
        const supabase = createAdminClient();
        let written = 0;
        const errors: string[] = [];
        for (const { unitKey, tsx } of overlayUnits) {
          const path = unitKeyToStoragePath(unitKey, buildId);
          const { error } = await supabase.storage
            .from(SITE_SCREENSHOTS_BUCKET)
            .upload(path, Buffer.from(tsx, "utf8"), { contentType: "text/plain", upsert: true });
          if (error) {
            errors.push(`${unitKey} → ${path}: ${error.message}`);
            continue;
          }
          written++;
        }
        // A failed overlay write is LOUD: the published clone would silently drop
        // a draft edit otherwise. (Storage copy above is fail-soft because the
        // base artifact still exists; an overlay miss loses the user's edit.)
        if (errors.length > 0) {
          throw new Error(`publish-draft: ${errors.length} overlay upload(s) failed:\n${errors.join("\n")}`);
        }
        return written;
      });
      console.log(`[publish-draft] overlaid ${overlaid} draft unit(s) onto build ${buildId}`);

      // ── 6. Dispatch compose to run the rest of the pipeline. The build row is
      //       already status='queued'; compose flips it to 'composing'. ──
      await step.sendEvent("dispatch-compose", {
        name: "site/compose.requested",
        data: { projectId, tenantId, buildId },
      });

      return { draftId, buildId, blocksCloned, pagesCloned, storageCopied, overlaid };
    } catch (err) {
      // markBuildFailed marks the site_builds row failed AND (per Task 8)
      // unlocks the draft (publishing → active) so the user can retry.
      await markBuildFailed({ buildId, projectId, phase: "composing", error: err });
      throw err;
    }
  },
);
