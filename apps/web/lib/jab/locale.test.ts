import { describe, it, expect } from "vitest";
import { localeToBcp47, localeDir } from "./locale";

describe("localeToBcp47", () => {
  it("drops the region and lowercases (en_US → en, de_DE → de)", () => {
    expect(localeToBcp47("en_US")).toBe("en");
    expect(localeToBcp47("de_DE")).toBe("de");
    expect(localeToBcp47("pt_BR")).toBe("pt");
    expect(localeToBcp47("FR_fr")).toBe("fr");
  });

  it("passes through bare language subtags", () => {
    expect(localeToBcp47("ar")).toBe("ar");
    expect(localeToBcp47("ckb")).toBe("ckb");
  });

  it("accepts hyphenated input too (de-DE → de)", () => {
    expect(localeToBcp47("de-DE")).toBe("de");
  });

  it("defaults to en for null/undefined/empty", () => {
    expect(localeToBcp47(null)).toBe("en");
    expect(localeToBcp47(undefined)).toBe("en");
    expect(localeToBcp47("")).toBe("en");
    expect(localeToBcp47("   ")).toBe("en");
  });
});

describe("localeDir", () => {
  it("returns rtl for known RTL languages (ignoring region)", () => {
    expect(localeDir("ar")).toBe("rtl");
    expect(localeDir("he_IL")).toBe("rtl");
    expect(localeDir("fa_IR")).toBe("rtl");
    expect(localeDir("ur")).toBe("rtl");
    expect(localeDir("ckb")).toBe("rtl");
    expect(localeDir("ps")).toBe("rtl");
  });

  it("returns ltr for LTR languages and unknowns", () => {
    expect(localeDir("en_US")).toBe("ltr");
    expect(localeDir("de_DE")).toBe("ltr");
    expect(localeDir("ja")).toBe("ltr");
    expect(localeDir("zz")).toBe("ltr");
  });

  it("defaults to ltr for null/undefined/empty", () => {
    expect(localeDir(null)).toBe("ltr");
    expect(localeDir(undefined)).toBe("ltr");
    expect(localeDir("")).toBe("ltr");
  });
});
