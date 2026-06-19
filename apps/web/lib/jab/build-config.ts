/**
 * build-config — the canonical `site_builds.config` shape (e2e-loop §2.4).
 *
 * This is the ONLY shape written to site_builds.config. Defined once here and
 * imported by:
 *   - edit-site.ts (Phase 2) — writes the full edit shape on create-result-build.
 *   - the deploy-history label (Phase 3) — reads config.mode / config.prompt.
 *   - approval carry-forward (Phase 2/S4) — reads config.source_build_id /
 *     config.changed_slugs.
 *
 * Non-async pure module — safe to import from server actions, workers, and the
 * client-bundled label helpers alike.
 */

import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

export type BuildConfig =
  | { mode: "full"; locale?: string }
  | {
      mode: "edit";
      source_build_id: string;
      scope: WorkspaceEditScope; // §2.6 — "component" | "shell"
      target: string; // block_name | shell kind ('header'|'footer')
      prompt: string; // raw user/plan text (human-readable)
      regeneration_prompt: string; // guidance threaded into the generator
      action: string; // planner's human summary, e.g. "Regenerated the Hero block"
      edit_id: string; // workspace_edits.id
      message_id: string | null; // chat_messages.id that triggered it (null for the manual form path)
      changed_slugs: string[]; // computed by edit-site's compute-changed-pages step
      change_reason: "component_pages" | "shell_all" | null;
      /**
       * Static front page slug carried forward from the SOURCE build's config
       * (full builds write it via discover-site's persist-front-page-slug as a
       * legacy untyped key). compose-site's front-page resolution reads it —
       * without it every edit build dies at compose ("no static front-page
       * configured"); the route_path='/' fallback is dead (routePathFor never
       * emits '/'). Null when the source never detected one (compose then
       * fail-louds exactly like a full build without a front page).
       */
      front_page_slug: string | null;
      /**
       * Front-page mode carried from the SOURCE build's config so an edit /
       * publish build of a blog-index site (show_on_front='posts') keeps
       * emitting the blog index. Full builds re-derive this from the /site
       * manifest at discovery. Absent on pre-blog-index builds → compose
       * treats it as the static path (back-compat).
       */
      show_on_front?: "page" | "posts";
      /** Incremental-sync watermark carried from the source so JAB_INCREMENTAL_SKIP survives an edit. */
      last_sync_watermark?: string;
      /**
       * Raw WP locale (e.g. "en_US") carried from the SOURCE build's config so an
       * edit / publish build emits the same <html lang dir>. Full builds persist
       * it at discovery from the /site manifest. Absent on pre-locale builds →
       * compose derives "en" / "ltr" (byte-identical to the pre-locale output).
       */
      locale?: string;
    }
  | {
      /**
       * Live-Draft publish bridge. A publish_draft build clones the draft's
       * base build (inventory + component/shell/source Storage) and overlays
       * the draft's effective unit versions + merged token override, then flows
       * through the EXISTING compose/deploy/verify/review/publish pipeline.
       * Additive — full/edit builds are byte-identical.
       */
      mode: "publish_draft";
      /** drafts.id being published (locked to 'publishing' during the flow). */
      draft_id: string;
      /** The draft's base build — the clone source for inventory + Storage. */
      base_build_id: string;
      /** = base_build_id; the carry-forward source verify-fidelity reads. */
      source_build_id: string;
      /** Union of all active draft edits' changed_slugs (the approval carry-forward set). */
      changed_slugs: string[];
      /**
       * Merged token override (base tokens + active token deltas). Present ONLY
       * when the draft has active token edits. compose prefers it over
       * projects.design_tokens; the project's brand is mutated to it ONLY when
       * the build is promoted to production (publishBuildAction).
       */
      tokens?: ThemeJsonTokens;
      /** Static front-page slug carried from the base build's config (see edit mode). */
      front_page_slug: string | null;
      /** Front-page mode carried from the base build's config (blog-index survives publish). */
      show_on_front?: "page" | "posts";
      /** Incremental-sync watermark carried from the base build's config. */
      last_sync_watermark?: string;
      /** Raw WP locale carried from the base build's config (<html lang dir>). */
      locale?: string;
    };

/**
 * Narrowing type guard. Returns true only for a well-formed edit config
 * (mode === "edit"). Defensive against arbitrary jsonb read back from the DB:
 * null / undefined / non-object / wrong-mode all return false.
 */
export function isEditConfig(
  config: unknown,
): config is Extract<BuildConfig, { mode: "edit" }> {
  return (
    typeof config === "object" &&
    config !== null &&
    (config as { mode?: unknown }).mode === "edit"
  );
}

/**
 * Narrowing type guard for the Live-Draft publish bridge config
 * (mode === "publish_draft"). Same defensive posture as isEditConfig:
 * null / undefined / non-object / wrong-mode all return false.
 */
export function isPublishDraftConfig(
  config: unknown,
): config is Extract<BuildConfig, { mode: "publish_draft" }> {
  return (
    typeof config === "object" &&
    config !== null &&
    (config as { mode?: unknown }).mode === "publish_draft"
  );
}

/**
 * The single carry-forward source for verify-fidelity's approval carry-forward.
 * Returns the source build + the changed-slug set for BOTH edit and
 * publish_draft builds (they both clone a source and re-approve unchanged
 * pages); null for a full build (nothing to carry forward). Keeping this one
 * helper means verify-fidelity has exactly one carry-forward code path.
 */
export function configCarryForwardSource(
  c: BuildConfig,
): { sourceBuildId: string; changedSlugs: string[] } | null {
  if (c.mode === "edit") return { sourceBuildId: c.source_build_id, changedSlugs: c.changed_slugs };
  if (c.mode === "publish_draft") return { sourceBuildId: c.source_build_id, changedSlugs: c.changed_slugs };
  return null;
}

export interface CarriedSourceConfig {
  front_page_slug: string | null;
  show_on_front?: "page" | "posts";
  last_sync_watermark?: string;
  locale?: string;
}

/**
 * Extract the config keys an edit build must inherit from its source build.
 * Tolerates both shapes: full builds carry front_page_slug / show_on_front as
 * legacy untyped keys; edit builds carry the typed fields (edit-on-edit chains).
 *
 * NOTE (orphaned — forward-compat only): this helper currently has NO production
 * consumer. The Live-Draft merge deleted edit-site.ts (its original caller), and
 * the publish path (publishBuildAction → redeployToProduction) REDEPLOYS the
 * already-composed reviewed build rather than cloning config into a new
 * site_builds row, so nothing reads a carried config today. It is kept (and
 * show_on_front added alongside front_page_slug) so a future
 * publish-as-new-build / edit-build path doesn't silently drop a blog-index
 * site's homepage mode (show_on_front='posts') and hard-fail compose.
 * Cleanup-or-wire is tracked as a follow-up; do not read its tests as evidence
 * of a live carry-forward path.
 */
export function carryForwardSourceConfig(sourceConfig: unknown): CarriedSourceConfig {
  if (typeof sourceConfig !== "object" || sourceConfig === null) {
    return { front_page_slug: null };
  }
  const cfg = sourceConfig as {
    front_page_slug?: unknown;
    last_sync_watermark?: unknown;
    show_on_front?: unknown;
    locale?: unknown;
  };
  const out: CarriedSourceConfig = {
    front_page_slug:
      typeof cfg.front_page_slug === "string" && cfg.front_page_slug.length > 0
        ? cfg.front_page_slug
        : null,
  };
  if (cfg.show_on_front === "page" || cfg.show_on_front === "posts") {
    out.show_on_front = cfg.show_on_front;
  }
  if (typeof cfg.last_sync_watermark === "string" && cfg.last_sync_watermark.length > 0) {
    out.last_sync_watermark = cfg.last_sync_watermark;
  }
  if (typeof cfg.locale === "string" && cfg.locale.trim().length > 0) {
    out.locale = cfg.locale.trim();
  }
  return out;
}

/**
 * Build the front-page slice of site_builds.config from the /site manifest's
 * show_on_front mode + the resolved static front-page slug. Returns only the
 * keys that are known, so discovery can read-modify-write without clobbering
 * unrelated config keys. The KEY behavior change: show_on_front is persisted
 * even when there is no static slug (the blog-index case), which is what lets
 * compose emit the blog index instead of hard-failing.
 */
export function buildFrontPageConfigPatch(
  showOnFront: "page" | "posts" | null | undefined,
  resolvedFrontPageSlug: string | null,
): { show_on_front?: "page" | "posts"; front_page_slug?: string } {
  const patch: { show_on_front?: "page" | "posts"; front_page_slug?: string } = {};
  if (showOnFront === "page" || showOnFront === "posts") patch.show_on_front = showOnFront;
  if (typeof resolvedFrontPageSlug === "string" && resolvedFrontPageSlug.length > 0) {
    patch.front_page_slug = resolvedFrontPageSlug;
  }
  return patch;
}

/**
 * Patch for persisting the source WP locale into site_builds.config. Mirrors
 * buildFrontPageConfigPatch — returns {} (no key) for a blank locale so the
 * read-modify-write never writes an empty value.
 */
export function buildLocaleConfigPatch(
  locale: string | null | undefined,
): { locale?: string } {
  return locale && locale.trim().length > 0 ? { locale: locale.trim() } : {};
}
