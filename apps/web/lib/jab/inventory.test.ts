// apps/web/lib/jab/inventory.test.ts
import { describe, it, expect } from "vitest";
import type { BlockNode } from "./ability-client";
import { buildInventory } from "./inventory";

function blk(name: string | null, attrs: Record<string, unknown> = {}, inner: BlockNode[] = []): BlockNode {
  return { blockName: name, attrs, innerBlocks: inner, innerHTML: "", innerContent: [] };
}

describe("buildInventory — tree walk + counts", () => {
  it("counts occurrences across pages recursively", () => {
    const pages = [
      {
        slug: "home",
        post_type: "page",
        blocks: [
          blk("core/heading", { level: 1 }),
          blk("core/paragraph"),
          blk("core/columns", {}, [
            blk("core/column", {}, [blk("core/paragraph")]),
          ]),
        ],
      },
      {
        slug: "about",
        post_type: "page",
        blocks: [
          blk("core/heading", { level: 1 }),
          blk("core/paragraph"),
          blk("core/paragraph"),
        ],
      },
    ];
    const inv = buildInventory(pages);
    const heading = inv.find((b) => b.blockName === "core/heading")!;
    expect(heading.occurrenceCount).toBe(2);
    expect(heading.pageSlugs).toEqual(expect.arrayContaining(["home", "about"]));
    const paragraph = inv.find((b) => b.blockName === "core/paragraph")!;
    expect(paragraph.occurrenceCount).toBe(4);
    const column = inv.find((b) => b.blockName === "core/column")!;
    expect(column.occurrenceCount).toBe(1);
  });

  it("caps attr samples at 5 distinct shapes", () => {
    const blocks: BlockNode[] = [];
    for (let i = 0; i < 20; i++) {
      blocks.push(blk("core/heading", { level: (i % 6) + 1 }));
    }
    const inv = buildInventory([{ slug: "h", post_type: "page", blocks }]);
    const heading = inv.find((b) => b.blockName === "core/heading")!;
    expect(heading.attrSamples.length).toBeLessThanOrEqual(5);
  });

  it("preserves null blockName entries as their own inventory row", () => {
    const inv = buildInventory([
      {
        slug: "home",
        post_type: "page",
        blocks: [blk(null, {}), blk("core/heading")],
      },
    ]);
    const nullRow = inv.find((b) => b.blockName === null);
    expect(nullRow).toBeDefined();
    expect(nullRow!.occurrenceCount).toBe(1);
  });
});
