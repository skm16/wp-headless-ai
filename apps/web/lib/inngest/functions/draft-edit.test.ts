import { describe, it, expect } from "vitest";
import { unitKeyFor, exportNameFor, maxBytesFor } from "./draft-edit";

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
