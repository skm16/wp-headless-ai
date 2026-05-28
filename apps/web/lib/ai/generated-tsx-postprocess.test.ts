/**
 * Tests for generated-tsx-postprocess.ts
 *
 * The module imports "server-only" which is stubbed out by vitest setup,
 * and rewriteBlockNodeImports from @/lib/jab/import-rewrite (a pure function,
 * no server-only import).
 */
import { describe, it, expect, vi } from "vitest";

// Stub "server-only" before importing the module under test.
vi.mock("server-only", () => ({}));

import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComponent(name: string, body = "<div>{block.innerHTML}</div>", extra = "") {
  return `import type { BlockNode } from "@/lib/sdk/types";

export function ${name}({ block }: { block: BlockNode }) {
  return ${body};
}
${extra}`;
}

// ---------------------------------------------------------------------------
// 1. Code fence stripping
// ---------------------------------------------------------------------------

describe("code fence stripping", () => {
  it("strips a leading ```tsx fence", () => {
    const src = "```tsx\n" + makeComponent("Beer");
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    expect(result).not.toContain("```");
  });

  it("strips a leading ```typescript fence", () => {
    const src = "```typescript\n" + makeComponent("Beer");
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    expect(result).not.toContain("```");
  });

  it("strips a bare ``` fence", () => {
    const src = makeComponent("Beer") + "\n```";
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    expect(result).not.toContain("```");
  });

  it("strips fence lines in the middle of the file (not only at boundaries)", () => {
    const src = [
      "```tsx",
      `import type { BlockNode } from "@/lib/sdk/types";`,
      "```",
      "",
      "export function Beer({ block }: { block: BlockNode }) {",
      "  return <div />;",
      "}",
      "```",
    ].join("\n");
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    expect(result).not.toContain("```");
  });

  it("preserves inline backtick expressions inside JSX (not a fence)", () => {
    // A line that has content beyond the backticks should NOT be stripped.
    const src = makeComponent("Beer", "<div>{`hello`}</div>");
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    // The inline backtick expression should remain.
    expect(result).toContain("`hello`");
  });
});

// ---------------------------------------------------------------------------
// 2. BlockNode import rewriting
// ---------------------------------------------------------------------------

describe("BlockNode import rewriting", () => {
  it('rewrites @/lib/jab/ability-client to @/lib/sdk/types', () => {
    const src = `import type { BlockNode } from "@/lib/jab/ability-client";\n\nexport function Beer({ block }: { block: BlockNode }) {\n  return <div />;\n}\n`;
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    expect(result).toContain(`from "@/lib/sdk/types"`);
    expect(result).not.toContain("ability-client");
  });

  it("leaves already-correct @/lib/sdk/types imports unchanged", () => {
    const src = makeComponent("Beer");
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    expect(result).toContain(`from "@/lib/sdk/types"`);
  });
});

// ---------------------------------------------------------------------------
// 3. Export name alignment
// ---------------------------------------------------------------------------

describe("export name alignment", () => {
  it("appends alias export when LLM exports wrong name (BeerLayout vs Beer)", () => {
    const src = `import type { BlockNode } from "@/lib/sdk/types";

export function BeerLayout({ block }: { block: BlockNode }) {
  return <div />;
}
`;
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    expect(result).toContain("export { BeerLayout as Beer }");
  });

  it("leaves correct export name unchanged (no alias appended)", () => {
    const src = makeComponent("Beer");
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    // Alias should not be present.
    expect(result).not.toContain("export { Beer as Beer }");
    // But the original export should still be there.
    expect(result).toContain("export function Beer");
  });

  it("does not append alias when expected export already present", () => {
    const src = makeComponent("HeroBlock");
    const result = postprocessGeneratedTsx(src, { expectedExportName: "HeroBlock" });
    expect(result).not.toMatch(/export\s*\{/);
  });

  it("returns unchanged source when no export at all is found", () => {
    const src = `function NotExported() { return <div />; }`;
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    // Should not add any alias — let validateTsx catch the missing export.
    expect(result).not.toContain("export {");
  });
});

// ---------------------------------------------------------------------------
// 4. "use client" directive
// ---------------------------------------------------------------------------

describe('"use client" directive', () => {
  it('adds "use client" when useState is used', () => {
    const src = `import { useState } from "react";
import type { BlockNode } from "@/lib/sdk/types";

export function Counter({ block }: { block: BlockNode }) {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
`;
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Counter" });
    expect(result).toMatch(/^"use client";/);
  });

  it('adds "use client" when useEffect is used', () => {
    const src = `import { useEffect } from "react";
import type { BlockNode } from "@/lib/sdk/types";

export function Tracker({ block }: { block: BlockNode }) {
  useEffect(() => { console.log("mounted"); }, []);
  return <div />;
}
`;
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Tracker" });
    expect(result).toMatch(/^"use client";/);
  });

  it('does NOT add duplicate "use client" if already present (double-quote)', () => {
    const src = `"use client";
import { useState } from "react";
import type { BlockNode } from "@/lib/sdk/types";

export function Counter({ block }: { block: BlockNode }) {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(x => x + 1)}>{n}</button>;
}
`;
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Counter" });
    // Directive should appear exactly once.
    const matches = result.match(/"use client"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("does NOT add duplicate \"use client\" if already present (single-quote)", () => {
    const src = `'use client';
import { useState } from "react";
import type { BlockNode } from "@/lib/sdk/types";

export function Counter({ block }: { block: BlockNode }) {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(x => x + 1)}>{n}</button>;
}
`;
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Counter" });
    // Neither a new double-quote directive nor a second single-quote directive.
    const doubleMatches = result.match(/"use client"/g) ?? [];
    const singleMatches = result.match(/'use client'/g) ?? [];
    expect(doubleMatches.length + singleMatches.length).toBe(1);
  });

  it('does NOT add "use client" when no hooks are used', () => {
    const src = makeComponent("Beer");
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });
    expect(result).not.toContain("use client");
  });

  it('does NOT add "use client" for non-hook identifiers that share substrings', () => {
    // "useCustomThing" is not in CLIENT_HOOKS — should not trigger.
    const src = `import type { BlockNode } from "@/lib/sdk/types";

export function Widget({ block }: { block: BlockNode }) {
  const val = useCustomThing(); // user-defined hook, not a React built-in
  return <div>{val}</div>;
}
`;
    // Note: useCustomThing would actually match the pattern with word boundary
    // but since it is not in the CLIENT_HOOKS list it won't match. Confirm no directive.
    const result = postprocessGeneratedTsx(src, { expectedExportName: "Widget" });
    expect(result).not.toContain("use client");
  });
});

// ---------------------------------------------------------------------------
// 5. Composition — multiple fixes at once
// ---------------------------------------------------------------------------

describe("combined postprocessing", () => {
  it("fixes all four issues simultaneously", () => {
    const src = [
      "```tsx",
      `import type { BlockNode } from "@/lib/jab/ability-client";`,
      `import { useState } from "react";`,
      "",
      "export function BeerLayout({ block }: { block: BlockNode }) {",
      "  const [open, setOpen] = useState(false);",
      "  return <div onClick={() => setOpen(o => !o)}>{block.innerHTML}</div>;",
      "}",
      "```",
    ].join("\n");

    const result = postprocessGeneratedTsx(src, { expectedExportName: "Beer" });

    // 1. No code fences.
    expect(result).not.toContain("```");
    // 2. Correct import path.
    expect(result).toContain(`from "@/lib/sdk/types"`);
    expect(result).not.toContain("ability-client");
    // 3. Alias export appended.
    expect(result).toContain("export { BeerLayout as Beer }");
    // 4. "use client" directive added.
    expect(result).toMatch(/^"use client";/);
  });
});
