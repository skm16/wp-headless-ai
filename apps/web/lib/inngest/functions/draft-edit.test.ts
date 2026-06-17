import { describe, it, expect, afterEach } from "vitest";
import { unitKeyFor, exportNameFor, maxBytesFor, detectAndMaybeStripDeadClasses } from "./draft-edit";

describe("draft-edit pure helpers", () => {
  it("unitKeyFor maps component targets to block names and shell targets to shell: keys", () => {
    expect(unitKeyFor("component", "acf/hero")).toBe("acf/hero");
    expect(unitKeyFor("shell", "header")).toBe("shell:header");
    expect(unitKeyFor("shell", "footer")).toBe("shell:footer");
  });

  it("exportNameFor matches the dispatcher convention for components and Header/Footer for shell", () => {
    expect(exportNameFor("component", "acf/hero")).toBe("AcfHero");
    expect(exportNameFor("shell", "header")).toBe("Header");
    expect(exportNameFor("shell", "footer")).toBe("Footer");
  });

  it("maxBytesFor uses the component cap for components and the shell cap for shell", () => {
    expect(maxBytesFor("component")).toBe(10_000);
    expect(maxBytesFor("shell")).toBe(24_000);
  });
});

const TOKENS = { colorPalette: [{ slug: "primary", color: "#0a4f8a" }] };

describe("detectAndMaybeStripDeadClasses", () => {
  const prev = process.env.JAB_STRIP_DEAD_CLASSES;
  afterEach(() => {
    if (prev === undefined) delete process.env.JAB_STRIP_DEAD_CLASSES;
    else process.env.JAB_STRIP_DEAD_CLASSES = prev;
  });

  it("reports the dead count and leaves TSX untouched when the flag is off (default)", async () => {
    delete process.env.JAB_STRIP_DEAD_CLASSES;
    const tsx = `export function X() { return <div className="text-4xl footer-v2-grid">y</div>; }`;
    const r = await detectAndMaybeStripDeadClasses({ tsx, tokens: TOKENS, themeCss: null });
    expect(r.deadCount).toBe(1);
    expect(r.tsx).toBe(tsx);
  });

  it("strips dead classes when JAB_STRIP_DEAD_CLASSES=1", async () => {
    process.env.JAB_STRIP_DEAD_CLASSES = "1";
    const tsx = `export function X() { return <div className="text-4xl footer-v2-grid">y</div>; }`;
    const r = await detectAndMaybeStripDeadClasses({ tsx, tokens: TOKENS, themeCss: null });
    expect(r.deadCount).toBe(1);
    expect(r.tsx).toBe(`export function X() { return <div className="text-4xl">y</div>; }`);
  });
});
