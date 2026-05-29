import { describe, it, expect } from "vitest";
import { validateTsx, cptTemplatePrompt } from "./component-generator";
import type { EnrichedInventoryEntry } from "@/lib/jab/inventory";

describe("validateTsx", () => {
  it("accepts a valid TSX component", () => {
    const code = `
import React from "react";
export function Heading({ level = 1, content }: { level?: number; content: string }) {
  return <h1>{content}</h1>;
}
`;
    const errors = validateTsx(code, "Heading.tsx");
    expect(errors).toHaveLength(0);
  });

  it("rejects malformed JSX (unclosed tag)", () => {
    const code = `export function Bad() { return <div>unclosed; }`;
    const errors = validateTsx(code, "Bad.tsx");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects malformed JSX (mismatched tags)", () => {
    const code = `export function Bad() { return <div><span></div>; }`;
    const errors = validateTsx(code, "Bad.tsx");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a component with TS type annotations", () => {
    const code = `
interface Props { text: string; }
export function Para({ text }: Props) { return <p>{text}</p>; }
`;
    const errors = validateTsx(code, "Para.tsx");
    expect(errors).toHaveLength(0);
  });
});

describe("cptTemplatePrompt — children prop contract", () => {
  // The dispatcher (emitDispatcherTsx in compose-site-emit.ts) renders every
  // generated block as `<Component block={block} />` — no children passed.
  // If the CPT prompt asks for `children: React.ReactNode` (required), every
  // CPT template entry will fail tsc when the dispatcher imports it.
  // Therefore the prompt must declare children as OPTIONAL.
  function makeCptEntry(): EnrichedInventoryEntry {
    return {
      blockName: "cpt_template/beer",
      occurrenceCount: 1,
      pageSlugs: ["beer/example"],
      attrSamples: [{}],
      tier: "standard",
      kind: "cpt_template",
      spec: { blockNames: ["core/paragraph"], acfSchema: null },
    };
  }

  it("declares children as optional (children?:) in the rendered prompt", () => {
    const prompt = cptTemplatePrompt(makeCptEntry(), null);
    // Must contain the optional form, never a bare required `children:`.
    expect(prompt).toMatch(/children\?:\s*React\.ReactNode/);
    // Defensive: no required form (children: not preceded by `?`).
    expect(prompt).not.toMatch(/[^?]children:\s*React\.ReactNode/);
  });

  it("still asks for a layout component named {Cpt}Layout (export-name contract intact)", () => {
    const prompt = cptTemplatePrompt(makeCptEntry(), null);
    expect(prompt).toMatch(/BeerLayout/);
  });
});
