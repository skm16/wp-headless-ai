/**
 * Classic-editor content is keyed in block_inventory under the "__null__"
 * sentinel (WP Classic pages are a single blockName:null body). We promote it
 * into a real, editable wrapper component named ClassicContent. These two
 * strings are the single source of truth shared by every name-derivation site
 * (the repo keeps the pascal ALGORITHM duplicated on purpose — see
 * compose-site.ts:976 — but the __null__->ClassicContent mapping is centralized
 * here so it can't drift across those copies).
 */
export const CLASSIC_BLOCK_NAME = "__null__";
export const CLASSIC_COMPONENT_NAME = "ClassicContent";

/** True for the Classic sentinel ("__null__") or its TS-side null form. */
export function isClassicBlock(blockName: string | null): boolean {
  return blockName === null || blockName === CLASSIC_BLOCK_NAME;
}

/** The component name the Classic block resolves to (vs. the ugly auto "Null"). */
export function classicComponentName(): string {
  return CLASSIC_COMPONENT_NAME;
}

/**
 * Deterministic editable wrapper for Classic-editor body content. The live WP
 * HTML is injected by <Passthrough> (the audited raw-HTML sink); THIS component
 * only wraps + styles it, so it carries no raw-HTML sink of its own. Edit it to
 * restyle the body — container width, typography, spacing, or descendant
 * elements via Tailwind arbitrary variants (e.g. [&_h2]:text-3xl). The TEXT
 * lives in WordPress (source of truth, fetched live at render time); it cannot
 * be edited here.
 */
export function emitClassicContentTsx(): string {
  return `import type { BlockNode } from "@/lib/jab/ability-client";
import { Passthrough } from "./_passthrough";

/**
 * ClassicContent — editable wrapper for WordPress Classic-editor body HTML.
 * The HTML comes LIVE from WordPress via <Passthrough> (source of truth). Edit
 * THIS wrapper to restyle the body: container, typography, spacing, or
 * descendant elements via Tailwind arbitrary variants like [&_h2]:text-3xl.
 * To change the TEXT, edit it in WordPress.
 */
export function ClassicContent({ block }: { block: BlockNode }) {
  return (
    <div className="jab-classic-content">
      <Passthrough block={block} />
    </div>
  );
}
`;
}
