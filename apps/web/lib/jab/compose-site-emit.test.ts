import { describe, it, expect } from "vitest";
import {
  emitTsconfigJson,
  emitGitignore,
  emitPostcssConfig,
  emitNotFoundTsx,
  emitPackageJson,
  emitNextConfigTs,
  emitEnvExample,
  emitJabClientTs,
  emitTailwindConfigTs,
} from "./compose-site-emit";
import type { ThemeJsonTokens } from "./global-styles";

describe("compose-site-emit — static templates", () => {
  it("emitTsconfigJson returns valid JSON with strict + jsx:preserve", () => {
    const src = emitTsconfigJson();
    const parsed = JSON.parse(src);
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.jsx).toBe("preserve");
    expect(parsed.compilerOptions.paths["@/*"]).toEqual(["./*"]);
  });

  it("emitGitignore covers node_modules + .next + .env files", () => {
    const src = emitGitignore();
    expect(src).toMatch(/node_modules/);
    expect(src).toMatch(/\.next/);
    expect(src).toMatch(/\.env\.local/);
  });

  it("emitPostcssConfig is valid mjs exporting tailwindcss + autoprefixer", () => {
    const src = emitPostcssConfig();
    expect(src).toMatch(/tailwindcss/);
    expect(src).toMatch(/autoprefixer/);
    expect(src).toMatch(/export default/);
  });

  it("emitNotFoundTsx is a default-export React component", () => {
    const src = emitNotFoundTsx();
    expect(src).toMatch(/export default function NotFound/);
    expect(src).toMatch(/404/);
  });
});

describe("compose-site-emit — package.json", () => {
  it("emits valid JSON with isomorphic-dompurify in dependencies", () => {
    const src = emitPackageJson("Two Roads Brewing");
    const parsed = JSON.parse(src);
    expect(parsed.name).toBe("two-roads-brewing");
    expect(parsed.private).toBe(true);
    expect(parsed.dependencies["isomorphic-dompurify"]).toBeTruthy();
    expect(parsed.dependencies.next).toBeTruthy();
    expect(parsed.scripts.build).toBe("next build");
  });

  it("slug-cases the project name", () => {
    const parsed = JSON.parse(emitPackageJson("My Client's WP Site!!"));
    expect(parsed.name).toBe("my-client-s-wp-site");
  });

  it("falls back to 'headless-site' on degenerate input", () => {
    expect(JSON.parse(emitPackageJson("@@@")).name).toBe("headless-site");
  });
});

describe("compose-site-emit — @jab/core delegations", () => {
  it("emitNextConfigTs returns the @jab/core renderNextConfig output", () => {
    expect(emitNextConfigTs()).toMatch(/export default/);
  });
  it("emitEnvExample returns the @jab/core renderEnvExample output", () => {
    expect(emitEnvExample()).toMatch(/WP_URL/);
  });
  it("emitJabClientTs returns the @jab/core renderJabClient output", () => {
    expect(emitJabClientTs()).toMatch(/createClient/);
  });
});

describe("compose-site-emit — tailwind config", () => {
  it("emits a defaults-only config when tokens are null", () => {
    const src = emitTailwindConfigTs(null);
    expect(src).toMatch(/satisfies Config/);
    expect(src).toMatch(/content:/);
  });

  it("inlines color palette as theme.extend.colors keys", () => {
    const tokens = {
      colorPalette: [
        { slug: "brand-gold", color: "#ffc72c" },
        { slug: "navy", color: "#0a1929" },
      ],
      raw: {} as never,
    } as ThemeJsonTokens;
    const src = emitTailwindConfigTs(tokens);
    expect(src).toMatch(/"brand-gold":\s*"#ffc72c"/);
    expect(src).toMatch(/navy:\s*"#0a1929"/);
  });

  it("inlines font families as theme.extend.fontFamily keys", () => {
    const tokens = {
      fontFamilies: [{ slug: "display", fontFamily: "Syne, sans-serif" }],
      raw: {} as never,
    } as ThemeJsonTokens;
    const src = emitTailwindConfigTs(tokens);
    expect(src).toMatch(/display:\s*\["Syne, sans-serif"\]/);
  });

  it("inlines font sizes as theme.extend.fontSize keys", () => {
    const tokens = {
      fontSizes: [{ slug: "large", size: "32px" }],
      raw: {} as never,
    } as ThemeJsonTokens;
    const src = emitTailwindConfigTs(tokens);
    expect(src).toMatch(/large:\s*"32px"/);
  });

  it("emits a parseable TS file", async () => {
    const ts = await import("typescript");
    const src = emitTailwindConfigTs({ colorPalette: [{ slug: "gold", color: "#ffc72c" }], raw: {} as never } as ThemeJsonTokens);
    const sf = ts.createSourceFile("tailwind.config.ts", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });
});
