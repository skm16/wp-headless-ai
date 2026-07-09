import { findPostRelationFieldsInSample } from "@/lib/ai/component-generator";
import type { BlockDataCategory } from "@/lib/ai/patch-data-relevance";

/**
 * resolve-block-data-source — pure classification of a block's data source so
 * the patch prompt can describe the RIGHT field inventory. Order matters:
 * relation (a post-relation array whose refs carry post_type) beats direct-acf,
 * because a Featured-Beer-style block has its own config attrs AND a relation.
 */
export type BlockDataSource =
  | { kind: "direct-cpt"; cptSlug: string }
  | { kind: "relation"; fieldName: string; postType: string }
  | { kind: "direct-acf"; sample: Record<string, unknown> }
  | { kind: "none" };

export interface BlockInventoryLike {
  blockName: string | null;
  attrSamples: Array<Record<string, unknown>>;
}

export function resolveBlockDataSource(entry: BlockInventoryLike): BlockDataSource {
  const blockName = entry.blockName ?? "";

  // 1. cpt_template block → its own CPT schema. The CPT slug is encoded in the
  //    block_name (`cpt_template/{cptSlug}`, content-detection.ts:129) — there
  //    is NO cpt_slug column on block_inventory.
  if (blockName.startsWith("cpt_template/")) {
    const cptSlug = blockName.slice("cpt_template/".length).split("/")[0];
    if (cptSlug) return { kind: "direct-cpt", cptSlug };
  }

  const sample = entry.attrSamples[0];
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return { kind: "none" };

  // 2. relation — a post-relation array whose refs carry post_type.
  const relationFields = findPostRelationFieldsInSample(sample);
  for (const fieldName of relationFields) {
    const arr = (sample as Record<string, unknown>)[fieldName];
    const first = Array.isArray(arr) ? arr[0] : undefined;
    const postType =
      first && typeof first === "object" && typeof (first as Record<string, unknown>).post_type === "string"
        ? ((first as Record<string, unknown>).post_type as string)
        : null;
    if (postType) return { kind: "relation", fieldName, postType };
    // Field is a relation but the ref has no post_type — cannot resolve target.
    // Fall through to none rather than surface a wrong CPT.
  }
  if (relationFields.length > 0) return { kind: "none" };

  // 3. direct-acf — the block's own attribute fields.
  if (Object.keys(sample).length > 0) return { kind: "direct-acf", sample: sample as Record<string, unknown> };

  return { kind: "none" };
}

export function categoryOf(src: BlockDataSource): BlockDataCategory {
  return src.kind;
}
