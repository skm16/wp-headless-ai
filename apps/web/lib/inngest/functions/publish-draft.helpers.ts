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
