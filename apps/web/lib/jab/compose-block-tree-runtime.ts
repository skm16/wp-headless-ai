/**
 * compose-block-tree-runtime.ts — paradigm-aware runtime helper.
 *
 * Written as a normal apps/web module so vitest tests directly. At emission
 * time (Task 17), the compose-site worker reads this file's source, substitutes
 * the BlockNode type import, and writes to builds/<id>/project/lib/compose-block-tree.ts.
 *
 * NO IMPORTS from @/* — keep self-contained so emission substitution is a
 * single search-and-replace.
 */

// Minimal BlockNode shape — emission swaps this for the typed import.
export interface BlockNode {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks?: BlockNode[];
  innerHTML?: string;
}

// Omit + recurse instead of plain `BlockNode & { _key: string }`: innerBlocks
// must stay RenderableBlock[] so the positional _key tagging propagates to
// children. The plan spec used the intersection-only form, which would leave
// innerBlocks typed as BlockNode[] (no _key on grandchildren).
export type RenderableBlock = Omit<BlockNode, "innerBlocks"> & {
  _key: string;
  innerBlocks?: RenderableBlock[];
};

export interface BlockTreeRecord {
  blocks?: BlockNode[];
  acf?: Record<string, unknown>;
  content?: { rendered?: string };
  id?: number;
  title?: { rendered?: string };
  [key: string]: unknown;
}

export interface ComposeOptions {
  acfFlexFields?: Record<string, string[]>;
}

export function composeBlockTree(
  record: BlockTreeRecord,
  postType: string,
  paradigms: string[],
  opts: ComposeOptions = {},
): RenderableBlock[] {
  // An acf_flex page builder IS the whole page — the source theme renders the
  // flex layouts and ignores the_content. So suppress the_content paradigms
  // (gutenberg/classic) whenever acf_flex is present, even if a stale paradigms
  // array (e.g. carried forward by an incremental skip-unchanged build that
  // predates the detectParadigms fix) still lists them. Last line of defense
  // against leftover WP editor boilerplate rendering below the real layout.
  const hasFlex = paradigms.includes("acf_flex");
  const out: RenderableBlock[] = [];
  for (const paradigm of paradigms) {
    if (paradigm === "acf_flex") {
      out.push(...synthAcfFlex(record, postType, opts.acfFlexFields ?? {}));
    } else if (paradigm === "acf_template") {
      out.push(...synthAcfTemplate(record, postType));
    } else if (paradigm === "gutenberg" && !hasFlex) {
      out.push(...synthGutenberg(record));
    } else if (paradigm === "classic" && !hasFlex) {
      out.push(...synthClassic(record));
    }
  }
  return out;
}

function synthGutenberg(record: BlockTreeRecord): RenderableBlock[] {
  if (!Array.isArray(record.blocks)) return [];
  return tagWithKeys(record.blocks);
}

function tagWithKeys(blocks: BlockNode[], parentKey = ""): RenderableBlock[] {
  return blocks.map((b, i) => {
    const key = parentKey ? `${parentKey}.${i}` : String(i);
    const inner = Array.isArray(b.innerBlocks) ? tagWithKeys(b.innerBlocks, key) : undefined;
    return { ...b, _key: key, innerBlocks: inner };
  });
}

function synthAcfFlex(
  record: BlockTreeRecord,
  postType: string,
  fields: Record<string, string[]>,
): RenderableBlock[] {
  const fieldPaths = fields[postType] ?? [];
  const out: RenderableBlock[] = [];
  let flexIdx = 0;
  const acf = (record.acf ?? {}) as Record<string, unknown>;
  for (const fieldPath of fieldPaths) {
    const items = acf[fieldPath];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const layout = (item as { acf_fc_layout?: unknown }).acf_fc_layout;
      if (typeof layout !== "string") continue;
      out.push({
        blockName: `acf_flex/${postType}/${fieldPath}/${layout}`,
        attrs: item as Record<string, unknown>,
        innerBlocks: [],
        innerHTML: "",
        _key: `flex-${flexIdx}`,
      });
      flexIdx++;
    }
  }
  return out;
}

function synthAcfTemplate(record: BlockTreeRecord, postType: string): RenderableBlock[] {
  const acf = record.acf && typeof record.acf === "object" ? record.acf : {};
  const title =
    typeof record.title?.rendered === "string"
      ? record.title.rendered
      : typeof record.title === "string"
        ? record.title
        : undefined;

  return [
    {
      blockName: `cpt_template/${postType}`,
      attrs: {
        ...acf,
        title,
        id: record.id,
        slug: record.slug,
        content: record.content,
        rawRecord: record,
      } as Record<string, unknown>,
      innerBlocks: [],
      innerHTML: "",
      _key: "template-0",
    },
  ];
}

function synthClassic(record: BlockTreeRecord): RenderableBlock[] {
  const content = record.content?.rendered;
  if (typeof content !== "string" || content.length === 0) return [];
  return [
    {
      blockName: null,
      attrs: {},
      innerBlocks: [],
      innerHTML: content,
      _key: "classic-0",
    },
  ];
}
