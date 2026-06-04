import type { BlockNode } from "./ability-client";
import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";

/**
 * edit-impact — pure changed-page computation (spec §3.4, verifier blocker).
 *
 * Diffs the SOURCE build's POPULATED page_inventory.block_tree (migration 0027)
 * — NOT the capped block_inventory.page_slugs (cap=50 → fail-open). Walks each
 * page's tree recursively for `target`. Any uncertainty (null/non-array tree,
 * or >50 changed pages) widens to ALL pages (fail-closed, R4): reason=null
 * means "we widened to everything; treat as shell_all-equivalent for the gate".
 */

/** Cap above which we stop trusting the per-page diff and re-review everything. */
export const MAX_CONFIDENT_CHANGED_PAGES = 50;

export interface SourcePageForImpact {
  slug: string;
  /** Raw WP BlockNode[] captured at discovery; null for pre-0027 source builds. */
  blockTree: BlockNode[] | null;
}

export interface ComputeChangedPagesInput {
  scope: WorkspaceEditScope;
  target: string;
  sourcePages: SourcePageForImpact[];
}

export interface ComputeChangedPagesResult {
  changedSlugs: string[];
  /** "component_pages" | "shell_all" on the confident path; null when fail-closed-widened. */
  reason: "component_pages" | "shell_all" | null;
}

function allSlugs(pages: SourcePageForImpact[]): string[] {
  return pages.map((p) => p.slug);
}

function treeContains(blocks: BlockNode[], target: string): boolean {
  for (const b of blocks) {
    if (b.blockName === target) return true;
    if (Array.isArray(b.innerBlocks) && b.innerBlocks.length > 0 && treeContains(b.innerBlocks, target)) {
      return true;
    }
  }
  return false;
}

export function computeChangedPages(input: ComputeChangedPagesInput): ComputeChangedPagesResult {
  if (input.scope === "shell") {
    return { changedSlugs: allSlugs(input.sourcePages), reason: "shell_all" };
  }

  // Component scope — walk each page's populated tree.
  const changed: string[] = [];
  for (const page of input.sourcePages) {
    const tree = page.blockTree;
    if (!Array.isArray(tree)) {
      // Uncertain diff source → fail closed.
      return { changedSlugs: allSlugs(input.sourcePages), reason: null };
    }
    if (treeContains(tree, input.target)) changed.push(page.slug);
  }

  if (changed.length > MAX_CONFIDENT_CHANGED_PAGES) {
    return { changedSlugs: allSlugs(input.sourcePages), reason: null };
  }
  return { changedSlugs: changed, reason: "component_pages" };
}
