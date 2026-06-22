import "server-only";
import { draftComponentName } from "@/lib/draft/bundle";
import { buildShellStoragePath } from "@/lib/ai/persist-shell-generation";
import { carryForwardSourceConfig } from "@/lib/jab/build-config";
import type { BuildConfig } from "@/lib/jab/build-config";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * publish-draft.helpers — pure clone/overlay pieces for the Live-Draft publish
 * bridge worker (publish-draft.ts). The worker clones the draft's base build
 * (inventory + Storage), then overlays each effective draft unit version onto
 * the cloned Storage. These two helpers are the pure seams the worker wires.
 */

/**
 * Map a draft `unit_key` to the Storage path the publish overlay writes (and
 * thus overwrites the cloned base file at):
 *   - "shell:header" / "shell:footer" → the project shell path
 *     (builds/<id>/project/components/site/<Kind>.tsx), the same path
 *     buildShellStoragePath produces and compose downloads.
 *   - any other key (a block name) → builds/<id>/components/<Name>.tsx, the
 *     Phase B component path. draftComponentName mirrors the PascalCase the
 *     draft system + compose-site-emit use, so the overlay lands on exactly the
 *     cloned base component file.
 */
export function unitKeyToStoragePath(unitKey: string, buildId: string): string {
  if (unitKey === "shell:header") return buildShellStoragePath(buildId, "header");
  if (unitKey === "shell:footer") return buildShellStoragePath(buildId, "footer");
  return `builds/${buildId}/components/${draftComponentName(unitKey)}.tsx`;
}

/**
 * Assemble the publish_draft BuildConfig the worker stamps onto the new build.
 * Carries front_page_slug / show_on_front / last_sync_watermark / locale from
 * the base build's config (via carryForwardSourceConfig — tolerates both the
 * legacy untyped full-build shape and the typed edit shape), the union
 * changedSlugs (the approval carry-forward set), and `tokens` ONLY when a
 * merged token override exists (no key when the draft had no token edits, so
 * compose falls back to projects.design_tokens — byte-identical to today).
 */
export function buildPublishDraftConfig(args: {
  draftId: string;
  baseBuildId: string;
  sourceConfig: unknown;
  changedSlugs: string[];
  tokens: ThemeJsonTokens | null;
}): Extract<BuildConfig, { mode: "publish_draft" }> {
  const carried = carryForwardSourceConfig(args.sourceConfig);
  const cfg: Extract<BuildConfig, { mode: "publish_draft" }> = {
    mode: "publish_draft",
    draft_id: args.draftId,
    base_build_id: args.baseBuildId,
    source_build_id: args.baseBuildId,
    changed_slugs: args.changedSlugs,
    front_page_slug: carried.front_page_slug,
  };
  if (carried.show_on_front) cfg.show_on_front = carried.show_on_front;
  if (carried.last_sync_watermark) cfg.last_sync_watermark = carried.last_sync_watermark;
  if (carried.locale) cfg.locale = carried.locale;
  if (args.tokens) cfg.tokens = args.tokens;
  return cfg;
}

/**
 * Clone a flat list of base-build Storage objects to the new build, rewriting
 * each `builds/<baseBuildId>/...` path to `builds/<buildId>/...`. FAIL-CLOSED:
 * any copy error throws after attempting them all, so the message names every
 * failure. The `copy` IO is injected (the worker passes
 * `supabase.storage.from(bucket).copy`), keeping this pure + unit-testable.
 *
 * Why fail-closed (C3): the base artifacts are load-bearing — components/ is
 * what compose downloads, source/ is the screenshot set verify-fidelity scores
 * the clone against. A silently-dropped object lets verify mark the page
 * `skipped`/`score:null`, which approval carry-forward then lets inherit the
 * source build's `approved` straight past the publish gate — deploying a page
 * this build never actually verified. A loud failure forces a retry instead.
 * (The shell files clone separately and stay fail-soft — a base build may
 * legitimately predate the shell artifact, and compose regenerates it.)
 */
export async function cloneStorageObjectsFailClosed(
  paths: string[],
  baseBuildId: string,
  buildId: string,
  copy: (from: string, to: string) => Promise<{ error: { message: string } | null }>,
): Promise<number> {
  const errors: string[] = [];
  let copied = 0;
  for (const path of paths) {
    const newPath = path.replace(`builds/${baseBuildId}/`, `builds/${buildId}/`);
    const { error } = await copy(path, newPath);
    if (error) {
      errors.push(`${path} → ${newPath}: ${error.message}`);
      continue;
    }
    copied++;
  }
  if (errors.length > 0) {
    throw new Error(
      `publish-draft: ${errors.length} base-artifact copy(ies) failed (fail-closed to protect the publish gate):\n${errors.join("\n")}`,
    );
  }
  return copied;
}
