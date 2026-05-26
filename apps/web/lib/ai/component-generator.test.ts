import { describe, it, expect } from "vitest";
import { validateTsx } from "./component-generator";

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
