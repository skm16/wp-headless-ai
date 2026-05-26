// apps/web/lib/jab/aggregate-computed-styles.ts
import "server-only";
import type { PageDiscoveryResult } from "./discovery-types";

/**
 * aggregate-computed-styles.ts
 *
 * Reduces per-instance computed CSS captures (one entry per block per
 * page per viewport) into the `{ viewports: { <vp>: { <prop>: [unique
 * values...] } } }` shape `block_inventory.computed_styles` persists.
 *
 * v1 = "unique values list" per property. Median + range fields hinted
 * at by design doc §6.1 are deferred — strings like "32px" / "rgb(...)"
 * aren't trivially numeric-median-able, and Phase B's prompts can
 * inspect the value list directly. Add numeric aggregation as a
 * follow-up if Phase B's prompt-token budget pressures it.
 */

export type AggregatedComputedStyles = Record<
  string, // block_name (or "__null__")
  {
    viewports: Record<
      string, // viewport width as string
      Record<string, string[]> // property name → unique value list
    >;
  }
>;

export function aggregateComputedStyles(
  pages: PageDiscoveryResult[],
): AggregatedComputedStyles {
  const out: AggregatedComputedStyles = {};

  for (const page of pages) {
    for (const [viewport, captures] of Object.entries(page.blockCapturesByViewport)) {
      for (const capture of captures) {
        const key = capture.blockName ?? "__null__";
        if (!out[key]) out[key] = { viewports: {} };
        if (!out[key].viewports[viewport]) out[key].viewports[viewport] = {};
        const vp = out[key].viewports[viewport];
        for (const [prop, value] of Object.entries(capture.computedStyles)) {
          if (typeof value !== "string" || value === "") continue;
          if (!vp[prop]) vp[prop] = [];
          if (!vp[prop].includes(value)) vp[prop].push(value);
        }
      }
    }
  }
  return out;
}
