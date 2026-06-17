import { describe, it, expect } from "vitest";
import {
  CLASSIC_BLOCK_NAME,
  CLASSIC_COMPONENT_NAME,
  isClassicBlock,
  classicComponentName,
  emitClassicContentTsx,
} from "@/lib/jab/classic-content";

describe("classic-content constants + helpers", () => {
  it("pins the sentinel + component name", () => {
    expect(CLASSIC_BLOCK_NAME).toBe("__null__");
    expect(CLASSIC_COMPONENT_NAME).toBe("ClassicContent");
    expect(classicComponentName()).toBe("ClassicContent");
  });

  it("isClassicBlock matches the sentinel and TS null, nothing else", () => {
    expect(isClassicBlock("__null__")).toBe(true);
    expect(isClassicBlock(null)).toBe(true);
    expect(isClassicBlock("core/paragraph")).toBe(false);
    expect(isClassicBlock("acf/hero")).toBe(false);
  });
});

describe("emitClassicContentTsx", () => {
  const src = emitClassicContentTsx();
  it("exports ClassicContent and wraps Passthrough with no raw-HTML sink of its own", () => {
    expect(src).toContain("export function ClassicContent");
    expect(src).toContain('import { Passthrough } from "./_passthrough"');
    expect(src).toContain("<Passthrough block={block} />");
    expect(src).not.toContain("__html"); // the raw-HTML sink stays in _passthrough.tsx only
  });
  it("has an editable wrapper class", () => {
    expect(src).toContain('className="jab-classic-content"');
  });
});
