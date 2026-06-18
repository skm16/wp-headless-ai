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

  it("rejects anything outside the 2-3 letter subtag shape (injection-safe)", () => {
    // The result is raw-interpolated into <html lang="..."> — a value carrying
    // quotes/brackets/spaces/digits must fall back to "en", never pass through.
    expect(localeToBcp47('ar"><script>alert(1)</script>')).toBe("en");
    expect(localeToBcp47('en"')).toBe("en");
    expect(localeToBcp47('a"b')).toBe("en");
    expect(localeToBcp47("en US")).toBe("en");
    expect(localeToBcp47("e1")).toBe("en");
    expect(localeToBcp47("english")).toBe("en"); // >3 letters
    expect(localeToBcp47("x")).toBe("en"); // <2 letters
  });

  it("does not throw on a non-string locale (contract violation → en)", () => {
    // isSiteManifest does not validate site.locale, so a non-string can reach here.
    expect(localeToBcp47(42 as unknown as string)).toBe("en");
    expect(localeToBcp47(true as unknown as string)).toBe("en");
    expect(localeToBcp47({} as unknown as string)).toBe("en");
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

  it("returns rtl for Saraiki (skr)", () => {
    expect(localeDir("skr")).toBe("rtl");
    expect(localeDir("skr_PK")).toBe("rtl");
  });

  it("defaults to ltr for null/undefined/empty/invalid/non-string", () => {
    expect(localeDir(null)).toBe("ltr");
    expect(localeDir(undefined)).toBe("ltr");
    expect(localeDir("")).toBe("ltr");
    expect(localeDir('ar"><x>')).toBe("ltr"); // invalid shape → no rtl smuggling
    expect(localeDir(42 as unknown as string)).toBe("ltr");
  });
});
