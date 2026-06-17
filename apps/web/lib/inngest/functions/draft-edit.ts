import "server-only";
import { inngest } from "@/lib/inngest/client";
import { EDIT_REQUESTED_EVENT, type SiteEditRequestedData } from "@/lib/inngest/edit-request-event";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureActiveDraft, bumpDraftVersion, loadDraftVersions, loadDraftSteps } from "@/lib/db/drafts";
import { effectiveUnitVersions, nextUnitVersionNo } from "@/lib/draft/state";
import { buildVersionedDraftArtifacts, defaultArtifactDeps } from "@/lib/draft/artifacts";
import { draftComponentName } from "@/lib/draft/bundle";
import { patchUnitSource } from "@/lib/ai/patch-component";
import { modelClientForTier } from "@/lib/ai/model-client";
import { computeChangedPages } from "@/lib/jab/edit-impact";
import { loadSourcePagesForImpact } from "./edit-site.helpers";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { resolveDeadClasses, rankThemeClassesForUnit } from "@/lib/jab/dead-class-detect";
import { resolveThemeTokens } from "@/lib/jab/global-styles";
import { emitThemeCss } from "@/lib/jab/compose-site-emit";
import { hostVariants, buildRoutePathMap } from "@/lib/jab/rewrite-origin-links";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * draft-edit — Live Draft replacement for the retired edit-site worker
 * (spec §6.2). One chat/manual edit = one draft step: patch the unit's
 * current TSX, bundle-gate the whole effective set, commit a new draft
 * version. NO site_builds row, NO compose/deploy/verify — those run once
 * at publish (Phase 3).
 *
 * retries: 0 — same rationale as edit-site (no duplicate LLM spend);
 * stranded rows are swept by autoFailStaleOpenEdits.
 */

export function unitKeyFor(scope: "component" | "shell", target: string): string {
  return scope === "shell" ? `shell:${target}` : target;
}

export function exportNameFor(scope: "component" | "shell", target: string): string {
  if (scope === "shell") return target === "header" ? "Header" : "Footer";
  return draftComponentName(target);
}

export function maxBytesFor(scope: "component" | "shell"): number {
  return scope === "shell" ? 24_000 : 10_000;
}

/**
 * Detect (and, behind JAB_STRIP_DEAD_CLASSES, strip) class names the patch LLM
 * invented that resolve to no CSS in the clone's closed Tailwind + theme-CSS
 * system. REPORT-ONLY by default — the count is a lower-bound quality signal,
 * not a certification. Pure: takes the same tokens/themeCss buildDraftCss uses.
 */
export async function detectAndMaybeStripDeadClasses(args: {
  tsx: string;
  tokens: ThemeJsonTokens | null;
  themeCss: string | null;
}): Promise<{ tsx: string; deadCount: number; dead: string[] }> {
  const { dead, cleaned } = await resolveDeadClasses({
    tsx: args.tsx,
    tokens_tw: args.tokens,
    themeCss: args.themeCss,
  });
  return { tsx: cleaned, deadCount: dead.length, dead };
}

/**
 * Load the base build's project theme inputs once for the patch step: the
 * resolved theme tokens (for the JIT probe + token-hex prompt section), the
 * emitted theme CSS (for the dead-class membership check), the shell-style
 * class-name inventory (for the SOFT prefer-inventory prompt section), AND the
 * origin-rewrite inputs (sourceHosts from projects.wp_url + routePathMap from
 * the base build's page_inventory.link/route_path — the SAME helpers + the same
 * fail-soft as Phase B, generate-components.ts:176-183). Mirrors artifacts.ts
 * loadProjectMeta + compose-site's extractThemeClassNames + buildRoutePathMap.
 * Fails SOFT to empty inputs — a missing token table, wp_url, or link map must
 * not block a chat edit; the origin rewrite only strips/maps absolute
 * source-origin links the LLM may introduce, so it fails soft, not loud.
 */
async function loadBaseThemeClassNames(
  admin: ReturnType<typeof createAdminClient>,
  baseBuildId: string,
  projectId: string,
): Promise<{
  classNames: string[];
  tokens: ThemeJsonTokens | null;
  themeCss: string | null;
  sourceHosts: string[];
  routePathMap: Record<string, string>;
}> {
  const [{ data }, { data: pages }] = await Promise.all([
    admin.from("projects").select("design_tokens, wp_url").eq("id", projectId).single(),
    admin.from("page_inventory").select("link, route_path").eq("site_build_id", baseBuildId),
  ]);
  const dt = (data?.design_tokens ?? {}) as {
    themeJson?: ThemeJsonTokens | null;
    themeStylesheets?: Array<{ css: string }> | null;
    colors?: import("@/lib/jab/global-styles").ScrapedBrandTokens["colors"];
    typography?: import("@/lib/jab/global-styles").ScrapedBrandTokens["typography"];
  };
  const sheets = dt.themeStylesheets ?? [];
  const tokens = resolveThemeTokens(dt.themeJson, { colors: dt.colors, typography: dt.typography });
  const themeCss = sheets.length > 0 ? emitThemeCss(sheets as never) : null;
  const { extractThemeClassNames } = await import("@/lib/ai/shell-prompts");

  // Origin-rewrite inputs. Same fail-soft as Phase B: a missing/invalid wp_url
  // yields [] (no rewrite); a missing link map yields {} (plain origin-stripping,
  // correct when route IS /<slug>).
  const wpUrl = (data as { wp_url?: string | null } | null)?.wp_url ?? null;
  let sourceHosts: string[] = [];
  if (wpUrl) {
    try {
      sourceHosts = hostVariants(wpUrl);
    } catch {
      sourceHosts = [];
    }
  }
  const routePathMap = buildRoutePathMap(
    (pages ?? []).map((p) => ({
      link: (p as { link: string | null }).link ?? null,
      route_path: (p as { route_path: string }).route_path,
    })),
  );

  // UNCAPPED (review finding #5) — the patch step ranks this against current.tsx
  // (rankThemeClassesForUnit, Task 1) and caps THERE, so a class the component
  // already uses must not be dropped by the extractor's length-DESC top-80.
  return {
    classNames: extractThemeClassNames(sheets, Number.MAX_SAFE_INTEGER),
    tokens,
    themeCss,
    sourceHosts,
    routePathMap,
  };
}

export const draftEdit = inngest.createFunction(
  { id: "draft-edit", retries: 0 },
  { event: EDIT_REQUESTED_EVENT },
  async ({ event, step }) => {
    const data = event.data as SiteEditRequestedData;
    const { editId, projectId, tenantId, scope, target } = data;
    const guidance = (data.regenerationPrompt ?? data.prompt ?? "").trim();
    const admin = createAdminClient();

    const failEdit = async (message: string) => {
      await admin
        .from("workspace_edits")
        .update({ status: "failed", error_text: message, finished_at: new Date().toISOString() })
        .eq("id", editId)
        .in("status", ["queued", "running"]);
      if (data.messageId) {
        await admin
          .from("chat_messages")
          .update({ content: `That edit couldn't be applied: ${message}`, needs_clarification: true })
          .eq("id", data.messageId);
      }
    };

    // 1. Claim the edit.
    await step.run("mark-edit-running", async () => {
      await admin
        .from("workspace_edits")
        .update({ status: "running" })
        .eq("id", editId)
        .in("status", ["queued", "running"]);
    });

    // 2. Ensure the draft + link the edit row to it.
    const draft = await step.run("ensure-draft", async () => {
      const d = await ensureActiveDraft(projectId, tenantId);
      if (d.status !== "active") {
        throw new Error(`draft ${d.id} is '${d.status}' — publish in progress, retry after it finishes`);
      }
      await admin.from("workspace_edits").update({ draft_id: d.id }).eq("id", editId);
      return d;
    }).catch(async (err: unknown) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!draft) return { failed: true };

    // 3. Load the unit's CURRENT source: latest active draft snapshot, else base build.
    const current = await step.run("load-current-source", async () => {
      const unitKey = unitKeyFor(scope, target);
      const [versions, steps] = await Promise.all([loadDraftVersions(draft.id), loadDraftSteps(draft.id)]);
      const effective = effectiveUnitVersions(versions, steps);
      const snapshot = effective.get(unitKey);
      if (snapshot) return { tsx: snapshot.tsx, versions };

      const storage = admin.storage.from(SITE_SCREENSHOTS_BUCKET);
      const path =
        scope === "shell"
          ? `builds/${draft.base_build_id}/project/components/site/${target === "header" ? "Header" : "Footer"}.tsx`
          : `builds/${draft.base_build_id}/components/${draftComponentName(target)}.tsx`;
      const { data: file } = await storage.download(path);
      if (!file) {
        throw new Error(`no source found for unit '${unitKey}' in draft or base build (${path})`);
      }
      return { tsx: await file.text(), versions };
    }).catch(async (err: unknown) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!current) return { failed: true };

    // 4. Patch LLM, then run the deterministic dead-class oracle over the
    //    result. Report-only by default; JAB_STRIP_DEAD_CLASSES=1 strips.
    const patched = await step.run("patch-unit", async () => {
      const base = await loadBaseThemeClassNames(admin, draft.base_build_id, projectId);
      const result = await patchUnitSource({
        currentTsx: current.tsx,
        guidance,
        exportName: exportNameFor(scope, target),
        maxBytes: maxBytesFor(scope),
        client: modelClientForTier(scope === "shell" ? "visual" : "standard"),
        // Rank the UNCAPPED inventory against the current source so the prompt
        // gets the relevant subset, not the length-capped global top-80 (#5).
        // rankThemeClassesForUnit lives in dead-class-detect.ts (Task 1), so this
        // wiring has NO forward dependency on Task 4.
        themeClassNames: rankThemeClassesForUnit({ themeClassNames: base.classNames, sourceDom: current.tsx }),
        tokens: base.tokens,
        // draft↔deployed origin parity: strip/map any absolute source-origin URL
        // the patch LLM introduces (entry.tsx only intercepts root-relative hrefs,
        // so an absolute source URL would escape the clone). routePathMap maps a
        // diverged WP permalink (/about-us/) to its real JAB route (/about).
        sourceHosts: base.sourceHosts,
        routePathMap: base.routePathMap,
      });
      if (!result.ok) throw new Error(`patch failed after ${result.attempts} attempts: ${result.error}`);
      const { tsx, deadCount, dead } = await detectAndMaybeStripDeadClasses({
        tsx: result.tsx,
        tokens: base.tokens,
        themeCss: base.themeCss,
      });
      if (deadCount > 0) {
        console.warn(
          `[draft-edit] edit ${editId} (${scope}:${target}) produced ${deadCount} dead class(es): ${dead.join(", ")}${
            process.env.JAB_STRIP_DEAD_CLASSES === "1" ? " — stripped" : " — report-only (set JAB_STRIP_DEAD_CLASSES=1 to strip)"
          }`,
        );
      }
      return tsx;
    }).catch(async (err: unknown) => {
      await failEdit(err instanceof Error ? err.message : String(err));
      return null;
    });
    if (!patched) return { failed: true };

    // 5. Bundle gate + CSS over the WHOLE effective set, upload at v(N+1).
    const artifacts = await step.run("bundle-and-css", async () => {
      const steps = await loadDraftSteps(draft.id);
      const effective = effectiveUnitVersions(current.versions, steps);
      const overrides = new Map<string, string>();
      for (const [key, row] of effective) overrides.set(key, row.tsx);
      overrides.set(unitKeyFor(scope, target), patched);
      return buildVersionedDraftArtifacts(
        { draftId: draft.id, nextVersion: draft.version + 1, baseBuildId: draft.base_build_id, overrides },
        defaultArtifactDeps(projectId),
      );
    }).catch(async (err: unknown) => {
      await failEdit(`compile gate: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!artifacts) return { failed: true };

    // 6. Commit: version row → edit row → CAS version bump (last).
    //
    // Ordering rationale (spec §6.2.6):
    //   a) draft_unit_versions INSERT — immutable, can be retried; if a crash
    //      occurs here nothing has changed for readers.
    //   b) workspace_edits UPDATE completed — signals "Applied" in the UI.
    //   c) bumpDraftVersion (CAS, LAST) — makes the new bundle visible to the
    //      preview pane by advancing drafts.version. Throws if a concurrent
    //      worker already moved the version, causing the whole step to fail and
    //      failEdit to fire.
    //
    // Orphan safety: if this worker crashes between (a) and (c), the inserted
    // draft_unit_versions row has `created_by_edit_id = editId` whose status is
    // 'running' (not 'completed'). effectiveUnitVersions only activates versions
    // whose step is completed — so the orphan is invisible to subsequent edits.
    // autoFailStaleOpenEdits sweeps the stuck 'running' edit row to 'failed',
    // which keeps it invisible indefinitely.
    await step.run("commit", async () => {
      const sourcePages = await loadSourcePagesForImpact(draft.base_build_id);
      const impact = computeChangedPages({ scope, target, sourcePages });
      const changedSlugs =
        impact.reason === null ? sourcePages.map((p) => p.slug) : impact.changedSlugs;

      const unitKey = unitKeyFor(scope, target);
      const { data: versionRow, error: vErr } = await admin
        .from("draft_unit_versions")
        .insert({
          draft_id: draft.id,
          project_id: projectId,
          tenant_id: tenantId,
          unit_key: unitKey,
          version_no: nextUnitVersionNo(current.versions, unitKey),
          tsx: patched,
          created_by_edit_id: editId,
        })
        .select("id")
        .single();
      if (vErr) throw new Error(`version insert failed: ${vErr.message}`);

      const { error: eErr } = await admin
        .from("workspace_edits")
        .update({
          status: "completed",
          unit_version_id: versionRow.id,
          changed_slugs: changedSlugs,
          change_reason: impact.reason,
          finished_at: new Date().toISOString(),
        })
        .eq("id", editId)
        .eq("status", "running");
      if (eErr) throw new Error(`edit update failed: ${eErr.message}`);

      // CAS gate: throws "concurrent writer moved draft" if lost the race.
      // Last write — makes the new preview version visible atomically.
      await bumpDraftVersion(draft.id, draft.version);
    }).catch(async (err: unknown) => {
      await failEdit(`commit: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

    return { draftId: draft.id, version: draft.version + 1 };
  },
);
