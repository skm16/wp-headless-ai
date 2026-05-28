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
  emitGlobalsCss,
  emitThemeCss,
  emitLayoutTsx,
  emitRobotsTs,
  emitSitemapTs,
  emitAcfFlexFieldsTs,
  emitPassthroughTsx,
  emitHomepageTsx,
  emitCatchAllPageTsx,
  emitRouteMapTs,
  emitReadmeMd,
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

describe("compose-site-emit — globals.css", () => {
  it("emits Tailwind directives with theme.css import when stylesheets present", () => {
    const src = emitGlobalsCss(true);
    expect(src).toMatch(/@tailwind base;/);
    expect(src).toMatch(/@import "\.\.\/styles\/theme\.css"/);
  });

  it("omits theme.css import when stylesheets absent", () => {
    const src = emitGlobalsCss(false);
    expect(src).toMatch(/@tailwind base;/);
    expect(src).not.toMatch(/theme\.css/);
  });
});

describe("compose-site-emit — theme.css", () => {
  it("returns empty string when stylesheets is empty", () => {
    expect(emitThemeCss([])).toBe("");
  });

  it("wraps each sheet under .jab-theme selector scope", () => {
    const src = emitThemeCss([
      { href: "https://x.test/style.css", css: ".btn { color: red; }" },
    ]);
    expect(src).toMatch(/\.jab-theme \{/);
    expect(src).toMatch(/\.btn \{ color: red; \}/);
    expect(src).toMatch(/\/\* source: https:\/\/x\.test\/style\.css \*\//);
  });

  it("joins multiple sheets with separators", () => {
    const src = emitThemeCss([
      { href: "https://x.test/a.css", css: ".a {}" },
      { href: "https://x.test/b.css", css: ".b {}" },
    ]);
    expect(src.match(/\.jab-theme \{/g)?.length).toBe(2);
  });

  it("neutralizes */ in href to prevent CSS comment termination", () => {
    const src = emitThemeCss([
      { href: "https://x.test/a.css?q=*/body{color:red}/*", css: ".btn {}" },
    ]);
    // The dangerous */ should be neutralized; nothing should escape the comment
    // ahead of the .jab-theme wrapper.
    const beforeScope = src.split(".jab-theme")[0];
    expect(beforeScope).not.toMatch(/\*\/\s*body\s*\{/);
  });
});

describe("compose-site-emit — app/layout.tsx", () => {
  it("composes Header + children + Footer with project metadata", () => {
    const src = emitLayoutTsx("Two Roads Brewing", "Craft beer since 2012");
    expect(src).toMatch(/import.*Header.*from\s+"@\/components\/site\/Header"/);
    expect(src).toMatch(/import.*Footer.*from\s+"@\/components\/site\/Footer"/);
    expect(src).toMatch(/import\s+"\.\/globals\.css"/);
    expect(src).toMatch(/title:\s+"Two Roads Brewing"/);
    expect(src).toMatch(/description:\s+"Craft beer since 2012"/);
    expect(src).toMatch(/<Header\s*\/>/);
    expect(src).toMatch(/<Footer\s*\/>/);
    expect(src).toMatch(/<html lang="en">/);
  });

  it("falls back to a default description when none provided", () => {
    const src = emitLayoutTsx("My Site", null);
    expect(src).toMatch(/description:\s+"Generated by JAB"/);
  });

  it("escapes quotes in project name + description", () => {
    const src = emitLayoutTsx('Sean\'s "Site"', 'It\'s great');
    expect(src).toMatch(/title:\s+"Sean's \\\"Site\\\""/);
  });
});

describe("compose-site-emit — robots.ts", () => {
  it("emits a MetadataRoute.Robots default export", () => {
    const src = emitRobotsTs("https://tworoadsbrewing.com");
    expect(src).toMatch(/import type \{ MetadataRoute \} from "next"/);
    expect(src).toMatch(/export default function robots\(\): MetadataRoute\.Robots/);
    expect(src).toMatch(/disallow:\s*\[.*"\/wp-admin\/"/);
    expect(src).toContain('"/wp-login.php"');
    expect(src).toContain('"/wp-json/"');
    expect(src).toMatch(/sitemap:\s*"https:\/\/tworoadsbrewing\.com\/sitemap\.xml"/);
  });

  it("strips trailing slashes from wpUrl before composing the sitemap URL", () => {
    const src = emitRobotsTs("https://tworoadsbrewing.com//");
    expect(src).toMatch(/sitemap:\s*"https:\/\/tworoadsbrewing\.com\/sitemap\.xml"/);
    expect(src).not.toMatch(/\/\/sitemap\.xml/);
  });
});

describe("compose-site-emit — sitemap.ts", () => {
  it("emits absolute URLs for every route", () => {
    const src = emitSitemapTs(
      [{ routePath: "/" }, { routePath: "/about" }, { routePath: "/beer/ipa" }],
      "https://tworoadsbrewing.com",
    );
    expect(src).toMatch(/url:\s*"https:\/\/tworoadsbrewing\.com\/"/);
    expect(src).toMatch(/url:\s*"https:\/\/tworoadsbrewing\.com\/about"/);
    expect(src).toMatch(/url:\s*"https:\/\/tworoadsbrewing\.com\/beer\/ipa"/);
  });

  it("handles empty inventory", () => {
    const src = emitSitemapTs([], "https://tworoadsbrewing.com");
    expect(src).toMatch(/return \[\];/);
  });

  it("strips trailing slashes from baseUrl before composing route URLs", () => {
    const src = emitSitemapTs([{ routePath: "/about" }], "https://tworoadsbrewing.com/");
    expect(src).toMatch(/url:\s*"https:\/\/tworoadsbrewing\.com\/about"/);
    expect(src).not.toMatch(/com\/\/about/);
  });
});

describe("compose-site-emit — acf-flex-fields", () => {
  it("extracts (post_type, field) pairs from acf_flex/* block names", () => {
    const src = emitAcfFlexFieldsTs([
      { blockName: "acf_flex/page/page_builder/large_hero" },
      { blockName: "acf_flex/page/page_builder/newsletter_cta" },
      { blockName: "acf_flex/page/bottom_sections/cta" },
      { blockName: "acf_flex/beer/tasting_notes/note" },
      { blockName: "core/heading" },
      { blockName: null },
    ]);
    expect(src).toMatch(/page:\s*\["page_builder",\s*"bottom_sections"\]/);
    expect(src).toMatch(/beer:\s*\["tasting_notes"\]/);
    expect(src).not.toMatch(/core/);
  });

  it("emits ACF_FLEX_FIELDS as a typed const", () => {
    const src = emitAcfFlexFieldsTs([{ blockName: "acf_flex/page/x/y" }]);
    expect(src).toMatch(/export const ACF_FLEX_FIELDS:\s*Record<string,\s*string\[\]>/);
  });

  it("emits empty map for no acf_flex entries", () => {
    const src = emitAcfFlexFieldsTs([{ blockName: "core/heading" }]);
    expect(src).toMatch(/ACF_FLEX_FIELDS:\s*Record<string,\s*string\[\]>\s*=\s*\{\}/);
  });

  it("dedupes fields per post_type", () => {
    const src = emitAcfFlexFieldsTs([
      { blockName: "acf_flex/page/page_builder/hero" },
      { blockName: "acf_flex/page/page_builder/newsletter" },
    ]);
    const matches = src.match(/page_builder/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("compose-site-emit — _passthrough.tsx", () => {
  it("emits a Passthrough component using isomorphic-dompurify", () => {
    const src = emitPassthroughTsx();
    expect(src).toMatch(/from "isomorphic-dompurify"/);
    expect(src).toMatch(/export function Passthrough/);
    expect(src).toMatch(/sanitize/);
    expect(src).toMatch(/wp-block-passthrough/);
  });

  it("imports BlockNode type from @/lib/sdk/types", () => {
    const src = emitPassthroughTsx();
    expect(src).toMatch(/import type \{ BlockNode \} from "@\/lib\/sdk\/types"/);
  });

  it("emitted TSX parses with ts.createSourceFile", async () => {
    const ts = await import("typescript");
    const src = emitPassthroughTsx();
    const sf = ts.createSourceFile("_passthrough.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });
});

import { emitDispatcherTsx } from "./compose-site-emit";


describe("compose-site-emit — _dispatcher.tsx", () => {
  it("emits import + case for every ok-status non-passthrough row", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "core/paragraph", tier: "trivial", compileStatus: "ok" },
      { blockName: "acf_flex/page/page_builder/large_hero", tier: "visual", compileStatus: "ok" },
    ]);
    expect(src).toMatch(/import \{ CoreHeading \} from "\.\/CoreHeading"/);
    expect(src).toMatch(/import \{ AcfFlexPagePageBuilderLargeHero \} from "\.\/AcfFlexPagePageBuilderLargeHero"/);
    expect(src).toMatch(/case "core\/heading":\s*return <CoreHeading/);
  });

  it("skips rows with compile_status = 'failed'", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "broken/block", tier: "visual", compileStatus: "failed" },
    ]);
    expect(src).toMatch(/case "core\/heading":/);
    expect(src).not.toMatch(/BrokenBlock/);
  });

  it("skips rows with tier = 'passthrough'", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "rare/block", tier: "passthrough", compileStatus: "skipped" },
    ]);
    expect(src).not.toMatch(/RareBlock/);
  });

  it("skips the __null__ sentinel", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "__null__", tier: "passthrough", compileStatus: "skipped" },
    ]);
    expect(src).not.toMatch(/Null__/);
  });

  it("emits a default branch returning Passthrough", () => {
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    expect(src).toMatch(/default:\s*return <Passthrough block=\{block\} \/>/);
  });

  it("emits a valid file even when inventory is empty", () => {
    const src = emitDispatcherTsx([]);
    expect(src).toMatch(/export function BlockDispatcher/);
    expect(src).toMatch(/default:\s*return <Passthrough/);
  });

  it("emitted TSX parses with ts.createSourceFile", async () => {
    const ts = await import("typescript");
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    const sf = ts.createSourceFile("_dispatcher.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });
});

describe("compose-site-emit — homepage", () => {
  it("emits app/page.tsx for a static front-page", () => {
    const src = emitHomepageTsx({
      slug: "home",
      abilityName: "jab/get-pages-by-slug",
      paradigms: ["acf_flex", "acf_template", "gutenberg"],
      postType: "page",
    });
    expect(src).toMatch(/import \{ jabClient \} from "@\/lib\/jab\/client"/);
    expect(src).toMatch(/import \{ BlockDispatcher \}/);
    expect(src).toMatch(/import \{ composeBlockTree \}/);
    expect(src).toMatch(/import \{ ACF_FLEX_FIELDS \}/);
    expect(src).toMatch(/export const revalidate = 60;/);
    expect(src).toMatch(/jabClient\.callAbility\("jab\/get-pages-by-slug",\s*\{\s*slug:\s*"home"/);
    expect(src).toMatch(/composeBlockTree\(record,\s*"page",\s*\["acf_flex","acf_template","gutenberg"\]/);
  });

  it("throws on null slug", () => {
    expect(() =>
      emitHomepageTsx({ slug: null, abilityName: null, paradigms: [], postType: "page" }),
    ).toThrow(/no static front-page/);
  });
});

describe("compose-site-emit — catch-all", () => {
  it("emits ROUTE_MAP lookup with notFound fallback", () => {
    const src = emitCatchAllPageTsx();
    expect(src).toMatch(/import \{ notFound \} from "next\/navigation"/);
    expect(src).toMatch(/import \{ ROUTE_MAP \}/);
    expect(src).toMatch(/if \(!entry\) notFound\(\)/);
    expect(src).toMatch(/export const revalidate = 60;/);
    expect(src).toMatch(/jabClient\.callAbility\(entry\.abilityName/);
    expect(src).not.toMatch(/if \(!fetcher\) notFound\(\)/);
  });
});

describe("compose-site-emit — route-map.ts", () => {
  it("emits ROUTE_MAP with abilityName + postType + paradigms per path", () => {
    const src = emitRouteMapTs([
      { routePath: "/about", postType: "page", paradigms: ["acf_flex"], abilityName: "jab/get-pages-by-slug" },
      { routePath: "/beer/ipa", postType: "beer", paradigms: ["acf_template"], abilityName: "jab/get-beers-by-slug" },
    ]);
    expect(src).toMatch(/export const ROUTE_MAP:\s*Record<string,/);
    expect(src).toMatch(/"about":\s*\{\s*abilityName:\s*"jab\/get-pages-by-slug",\s*postType:\s*"page"/);
    expect(src).toMatch(/"beer\/ipa":\s*\{\s*abilityName:\s*"jab\/get-beers-by-slug"/);
  });

  it("excludes the front-page route + strips leading slash", () => {
    const src = emitRouteMapTs([
      { routePath: "/", postType: "page", paradigms: [], abilityName: "jab/get-pages-by-slug" },
      { routePath: "/about", postType: "page", paradigms: [], abilityName: "jab/get-pages-by-slug" },
    ]);
    expect(src).not.toMatch(/"":/);
    expect(src).toMatch(/"about":/);
  });

  it("throws on duplicate route paths", () => {
    expect(() =>
      emitRouteMapTs([
        { routePath: "/about", postType: "page", paradigms: [], abilityName: "jab/get-pages-by-slug" },
        { routePath: "/about", postType: "story", paradigms: [], abilityName: "jab/get-stories-by-slug" },
      ]),
    ).toThrow(/duplicate route path/);
  });
});

describe("compose-site-emit — README.md", () => {
  it("emits markdown with project name in H1", () => {
    expect(emitReadmeMd("Two Roads Brewing")).toMatch(/^# Two Roads Brewing/m);
  });

  it("warns about regen overwriting edits", () => {
    expect(emitReadmeMd("Any Project")).toMatch(/regenerat|overwritten/i);
  });
});
