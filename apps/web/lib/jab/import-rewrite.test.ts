import { describe, it, expect } from "vitest";
import { rewriteBlockNodeImports } from "./import-rewrite";

describe("rewriteBlockNodeImports", () => {
  it("rewrites double-quoted import from @/lib/jab/ability-client", () => {
    const src = `import type { BlockNode } from "@/lib/jab/ability-client";\n\nexport default function Foo() {}\n`;
    const result = rewriteBlockNodeImports(src);
    expect(result).toContain(`import type { BlockNode } from "@/lib/sdk/types";`);
    expect(result).not.toContain("ability-client");
  });

  it("rewrites single-quoted import from @/lib/jab/ability-client", () => {
    const src = `import type { BlockNode } from '@/lib/jab/ability-client';\n\nexport default function Foo() {}\n`;
    const result = rewriteBlockNodeImports(src);
    expect(result).toContain(`import type { BlockNode } from "@/lib/sdk/types";`);
    expect(result).not.toContain("ability-client");
  });

  it("rewrites the comment-block inline BlockNode definition", () => {
    const src = [
      `import React from "react";`,
      `// Minimal BlockNode shape`,
      `// (copied from @jab/core to avoid a runtime import)`,
      `export interface BlockNode {`,
      `  blockName: string | null;`,
      `  attrs: Record<string, unknown>;`,
      `  innerBlocks: BlockNode[];`,
      `  innerHTML: string;`,
      `}`,
      ``,
      `export default function Foo() {}`,
      ``,
    ].join("\n");

    const result = rewriteBlockNodeImports(src);
    expect(result).toContain(`import type { BlockNode } from "@/lib/sdk/types";`);
    expect(result).not.toContain("Minimal BlockNode shape");
    expect(result).not.toContain("export interface BlockNode");
    expect(result).toContain("export default function Foo()");
  });

  it("leaves already-correct @/lib/sdk/types import unchanged", () => {
    const src = `import type { BlockNode } from "@/lib/sdk/types";\n\nexport default function Foo() {}\n`;
    const result = rewriteBlockNodeImports(src);
    expect(result).toBe(src);
  });

  it("is idempotent — running twice produces the same result", () => {
    const src = `import type { BlockNode } from "@/lib/jab/ability-client";\n\nexport default function Foo() {}\n`;
    const once = rewriteBlockNodeImports(src);
    const twice = rewriteBlockNodeImports(once);
    expect(twice).toBe(once);
  });

  it("rewrites import without trailing semicolon", () => {
    const src = `import type { BlockNode } from "@/lib/jab/ability-client"\n\nexport default function Foo() {}\n`;
    const result = rewriteBlockNodeImports(src);
    expect(result).toContain(`import type { BlockNode } from "@/lib/sdk/types";`);
    expect(result).not.toContain("ability-client");
  });

  it("rewrites import even when it is the last line (no trailing newline)", () => {
    const src = `import type { BlockNode } from "@/lib/jab/ability-client";`;
    const result = rewriteBlockNodeImports(src);
    expect(result).toContain(`from "@/lib/sdk/types"`);
    expect(result).not.toContain("ability-client");
  });

  it("rewrites a VALUE import (no `type` keyword) — the form the LLM emitted for CoreParagraph", () => {
    const src = `import React from "react";\nimport { BlockNode } from "@/lib/jab/ability-client";\n\nexport function Foo() {}\n`;
    const result = rewriteBlockNodeImports(src);
    expect(result).toContain(`import type { BlockNode } from "@/lib/sdk/types";`);
    expect(result).not.toContain("ability-client");
    expect(result).toContain(`import React from "react";`);
  });

  it("rewrites a single-quoted VALUE import", () => {
    const src = `import { BlockNode } from '@/lib/jab/ability-client';\n`;
    const result = rewriteBlockNodeImports(src);
    expect(result).toContain(`import type { BlockNode } from "@/lib/sdk/types";`);
    expect(result).not.toContain("ability-client");
  });

  it("rewrites an inline-type-modifier import `{ type BlockNode }`", () => {
    const src = `import { type BlockNode } from "@/lib/jab/ability-client";\n`;
    const result = rewriteBlockNodeImports(src);
    expect(result).toContain(`import type { BlockNode } from "@/lib/sdk/types";`);
    expect(result).not.toContain("ability-client");
  });
});
