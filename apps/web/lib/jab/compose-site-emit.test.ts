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
  scopeCssToJabTheme,
  absolutizeCssUrls,
  buildGoogleFontLinks,
  brandTypographyCss,
  harvestImageHosts,
  emitMediaImageTsx,
  emitDispatcherTsx,
  MEDIA_IMAGE_FILE_PATH,
  emitRelatedPostsTs,
  emitDynamicListsTs,
  emitDynamicListsMapTs,
  emitPostTypeMapTs,
  postTypeMapEntriesFromPages,
  modalParadigms,
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
  it("emits valid JSON with required runtime dependencies", () => {
    const src = emitPackageJson("Two Roads Brewing");
    const parsed = JSON.parse(src);
    expect(parsed.name).toBe("two-roads-brewing");
    expect(parsed.private).toBe(true);
    expect(parsed.dependencies.next).toBeTruthy();
    expect(parsed.dependencies.react).toBeTruthy();
    // isomorphic-dompurify removed: jsdom→html-encoding-sniffer→@exodus/bytes
    // triggers ERR_REQUIRE_ESM on Vercel (see emitPassthroughTsx comment).
    expect(parsed.dependencies["isomorphic-dompurify"]).toBeUndefined();
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
  it("emitNextConfigTs includes remotePatterns hostname when wpUrl given", () => {
    const out = emitNextConfigTs("https://tworoadsbrewing.com");
    expect(out).toMatch(/remotePatterns/);
    expect(out).toMatch(/tworoadsbrewing\.com/);
  });
  it("emitNextConfigTs throws on empty / missing wpUrl — silent failure was burning pilots", () => {
    expect(() => emitNextConfigTs("")).toThrow(/wpUrl is required/);
    expect(() => emitNextConfigTs("   ")).toThrow(/wpUrl is required/);
    expect(() => emitNextConfigTs(undefined as unknown as string)).toThrow(/wpUrl is required/);
    expect(() => emitNextConfigTs(null as unknown as string)).toThrow(/wpUrl is required/);
  });
  it("emitNextConfigTs throws when wpUrl is unparseable rather than emitting a wildcard host", () => {
    expect(() => emitNextConfigTs("not a url")).toThrow(/not a valid URL/);
    expect(() => emitNextConfigTs("tworoadsbrewing.com")).toThrow(/not a valid URL/);
  });
  it("emitNextConfigTs whitelists extra hosts alongside the primary one", () => {
    const out = emitNextConfigTs("https://tworoadsbrewing.com", [
      "https://sp-ao.shortpixel.ai/foo",
      "i0.wp.com",
    ]);
    expect(out).toMatch(/tworoadsbrewing\.com/);
    expect(out).toMatch(/sp-ao\.shortpixel\.ai/);
    expect(out).toMatch(/i0\.wp\.com/);
  });
  it("emitNextConfigTs deduplicates the primary host if it also appears in extraHosts", () => {
    const out = emitNextConfigTs("https://tworoadsbrewing.com", ["https://tworoadsbrewing.com/foo"]);
    const matches = out.match(/tworoadsbrewing\.com/g);
    expect(matches?.length).toBe(1);
  });
  it("emitNextConfigTs silently skips unparseable extra hosts — wpUrl is the loud-error contract", () => {
    const out = emitNextConfigTs("https://tworoadsbrewing.com", ["", "  ", "not a url"]);
    expect(out).toMatch(/tworoadsbrewing\.com/);
    expect(out).not.toMatch(/"not a url"/);
  });
  it("emitEnvExample returns the @jab/core renderEnvExample output", () => {
    expect(emitEnvExample()).toMatch(/WP_URL/);
  });
  it("emitJabClientTs returns the @jab/core renderJabClient output", () => {
    expect(emitJabClientTs()).toMatch(/createClient/);
  });
});

describe("harvestImageHosts — CDN host scraper for remotePatterns", () => {
  it("extracts hosts from <img src=> in HTML", () => {
    const html = '<img src="https://sp-ao.shortpixel.ai/client/foo.png" alt="x">';
    expect(harvestImageHosts([html])).toEqual(["sp-ao.shortpixel.ai"]);
  });

  it("extracts hosts from srcset entries with descriptors", () => {
    const html =
      '<img srcset="https://i0.wp.com/foo.png 1x, https://i1.wp.com/foo.png 2x" />';
    expect(harvestImageHosts([html])).toEqual(["i0.wp.com", "i1.wp.com"]);
  });

  it("extracts hosts from background-image: url() in inline styles + CSS", () => {
    const css = 'body { background-image: url("https://cdn.example.com/bg.jpg"); }';
    const html = '<div style="background-image:url(https://cdn.example.com/bg2.webp)"></div>';
    expect(harvestImageHosts([html, css])).toEqual(["cdn.example.com"]);
  });

  it("extracts hosts from data-src / data-srcset lazy-load attrs (LiteSpeed, Lazysizes patterns)", () => {
    const html =
      '<img data-src="https://lazy.example.com/foo.jpg" data-srcset="https://lazy.example.com/2x.jpg 2x">';
    expect(harvestImageHosts([html])).toEqual(["lazy.example.com"]);
  });

  it("filters out non-image extensions (JS bundles, fonts, icons by extension)", () => {
    const html = `
      <script src="https://cdn.example.com/bundle.js"></script>
      <link href="https://fonts.example.com/foo.woff2" />
      <img src="https://images.example.com/photo.png" />
    `;
    expect(harvestImageHosts([html])).toEqual(["images.example.com"]);
  });

  it("filters out the primary host (caller already covers it via the wpUrl arg to emitNextConfigTs)", () => {
    const html =
      '<img src="https://tworoadsbrewing.com/a.png"><img src="https://cdn.example.com/b.png">';
    expect(harvestImageHosts([html], "tworoadsbrewing.com")).toEqual(["cdn.example.com"]);
  });

  it("returns a stable alphabetically-sorted unique-host set across many sources", () => {
    const sources = [
      '<img src="https://b.test/x.png">',
      '<img src="https://a.test/y.png">',
      '<img srcset="https://b.test/x@2x.png 2x">', // dedup
    ];
    expect(harvestImageHosts(sources)).toEqual(["a.test", "b.test"]);
  });

  it("ignores bare paths and malformed URLs without throwing", () => {
    const html = '<img src="/relative.png"><img src="not a url"><img src="https://ok.test/a.png">';
    expect(harvestImageHosts([html])).toEqual(["ok.test"]);
  });

  it("ignores null / undefined / non-string source entries (defensive against optional capture fields)", () => {
    expect(harvestImageHosts([null, undefined, "<img src='https://ok.test/a.png'>"]))
      .toEqual(["ok.test"]);
  });

  it("Two Roads pilot shape — ShortPixel CDN host is captured from footer markup", () => {
    // The footer.tsx in build 982f0d57 referenced sp-ao.shortpixel.ai
    // for the brand-tagline image. The harvester picks it up so the
    // emitted next.config.ts adds it to remotePatterns.
    const footerHtml = `
      <footer>
        <img
          decoding="async"
          loading="lazy"
          src="https://sp-ao.shortpixel.ai/client/to_auto,q_glossy,ret_img/https://tworoadsbrewing.com/wp-content/themes/tworoads/assets/public/images/footer-tagline.png"
          alt="Two Roads Brewing"
        />
      </footer>
    `;
    const hosts = harvestImageHosts([footerHtml], "tworoadsbrewing.com");
    expect(hosts).toContain("sp-ao.shortpixel.ai");
  });
});

describe("emitMediaImageTsx — generated project shim", () => {
  it("emits a parseable TSX module with the expected exports", async () => {
    const ts = await import("typescript");
    const src = emitMediaImageTsx();
    const sf = ts.createSourceFile("MediaImage.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
    expect(src).toMatch(/export function MediaImage/);
    expect(src).toMatch(/export function isWpHostedImage/);
  });

  it("imports BlockNode from the generated project's @/lib/sdk/types — not the SaaS path", () => {
    const src = emitMediaImageTsx();
    expect(src).toMatch(/from "@\/lib\/sdk\/types"/);
    expect(src).not.toMatch(/@\/lib\/jab\/ability-client/);
  });

  it("renders next/image only when same-origin per process.env.WP_URL, plain img otherwise", () => {
    const src = emitMediaImageTsx();
    expect(src).toMatch(/sameOrigin \? \(/);
    expect(src).toMatch(/<Image/);
    expect(src).toMatch(/<img\b/);
    expect(src).toMatch(/process\.env\.WP_URL/);
  });

  it("the dispatcher import specifier and the file storage path point at the same module", () => {
    expect(MEDIA_IMAGE_FILE_PATH).toBe("components/blocks/_platform/MediaImage.tsx");
    const dispatcher = emitDispatcherTsx([]);
    // Dispatcher imports MediaImage from "./_platform/MediaImage" — a relative
    // path that resolves to components/blocks/_platform/MediaImage.tsx from
    // components/blocks/_dispatcher.tsx.
    expect(dispatcher).toMatch(/from "\.\/_platform\/MediaImage"/);
  });

  it("emits parseImgFromInnerHTML — sourced-attr fallback for WP core/image blocks", () => {
    const src = emitMediaImageTsx();
    // The Stage-2 extractor must be present so the emitted shim handles
    // the common WP shape (attrs = {id, sizeSlug}, img markup in innerHTML).
    expect(src).toMatch(/export function parseImgFromInnerHTML/);
    expect(src).toMatch(/<img\\b\[\^>\]\*>/);
  });

  it("emits the three-stage fallback chain so a core/image with no attrs.url still renders", () => {
    const src = emitMediaImageTsx();
    // Stage 2: invoke the innerHTML parser when attrs has no src.
    expect(src).toMatch(/if \(!src && html\)/);
    expect(src).toMatch(/parseImgFromInnerHTML\(html\)/);
    // Stage 3: raw innerHTML passthrough when even the parser fails.
    expect(src).toMatch(/wp-block-image--passthrough/);
    // The early `return null` only fires when innerHTML is also empty.
    expect(src).toMatch(/if \(!src\)/);
    expect(src).toMatch(/html\.trim\(\)\.length > 0/);
  });
});

describe("emitDispatcherTsx — core/image routes to MediaImage shim", () => {
  it("imports MediaImage and registers it for core/image even when no LLM CoreImage was generated", () => {
    const src = emitDispatcherTsx([]);
    expect(src).toMatch(/import \{ MediaImage \}/);
    expect(src).toMatch(/"core\/image": MediaImage/);
  });

  it("suppresses the LLM-generated CoreImage import when core/image is in the inventory — MediaImage wins", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/image", tier: "standard", compileStatus: "ok" },
      { blockName: "core/paragraph", tier: "trivial", compileStatus: "ok" },
    ]);
    // CoreImage import should NOT be present — MediaImage replaces it.
    expect(src).not.toMatch(/import \{ CoreImage \}/);
    // CoreParagraph import should still be present (other LLM-generated blocks unaffected).
    expect(src).toMatch(/import \{ CoreParagraph \}/);
    // core/image entry in REGISTRY points at MediaImage, not CoreImage.
    expect(src).toMatch(/"core\/image": MediaImage/);
    expect(src).not.toMatch(/"core\/image": CoreImage/);
  });

  it("registers MediaImage for core/image even when Phase B failed to generate it (compile_status !== 'ok')", () => {
    // Phase B failure for core/image: row.compileStatus = 'failed'. The
    // `usable` filter in emitDispatcherTsx drops it, so the LLM-component
    // import isn't emitted. MediaImage still wins on the REGISTRY side.
    const src = emitDispatcherTsx([
      { blockName: "core/image", tier: "standard", compileStatus: "failed" },
    ]);
    expect(src).toMatch(/"core\/image": MediaImage/);
    expect(src).not.toMatch(/import \{ CoreImage \}/);
  });
});

describe("compose-site-emit — tailwind config", () => {
  it("emits a defaults-only config when tokens are null", () => {
    const src = emitTailwindConfigTs(null);
    expect(src).toMatch(/satisfies Config/);
    expect(src).toMatch(/content:/);
  });

  it("scopes utilities under important:'#jab-app' so Tailwind tokens outrank bundled .jab-theme legacy CSS", () => {
    // Bootstrap/Understrap themes ship `.bg-primary` etc.; the theme.css scoper
    // rewrites those to `.jab-theme .bg-primary` (specificity 0,2,0), which beats
    // Tailwind's `.bg-primary` (0,1,0). Scoping every Tailwind utility under the
    // `#jab-app` id (1,1,0) makes Tailwind tokens win by id-specificity — no
    // !important. Present regardless of whether tokens were captured.
    expect(emitTailwindConfigTs(null)).toMatch(/important:\s*"#jab-app"/);
    expect(
      emitTailwindConfigTs({ colorPalette: [{ slug: "primary", color: "#ffc72c" }], raw: {} as never } as ThemeJsonTokens),
    ).toMatch(/important:\s*"#jab-app"/);
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

  it("is byte-identical to the pre-fix output when no brand fonts are passed", () => {
    // Back-compat: the 2nd arg defaults to undefined → no .jab-theme font rules.
    expect(emitGlobalsCss(false)).toBe(emitGlobalsCss(false, undefined));
    expect(emitGlobalsCss(false)).not.toMatch(/\.jab-theme/);
  });

  it("appends scoped brand-font rules when brand fonts are supplied", () => {
    const src = emitGlobalsCss(true, { heading: "Anton", body: "Source Sans Pro" });
    expect(src).toMatch(/@import "\.\.\/styles\/theme\.css"/);
    expect(src).toMatch(/@tailwind utilities;/);
    expect(src).toMatch(/\.jab-theme\s*\{\s*font-family:\s*"Source Sans Pro"/);
    expect(src).toMatch(/\.jab-theme h1, \.jab-theme h2, \.jab-theme h3, \.jab-theme h4, \.jab-theme h5, \.jab-theme h6\s*\{\s*font-family:\s*"Anton"/);
  });
});

describe("compose-site-emit — brandTypographyCss", () => {
  it("returns empty for null/undefined/empty", () => {
    expect(brandTypographyCss(null)).toBe("");
    expect(brandTypographyCss(undefined)).toBe("");
    expect(brandTypographyCss({})).toBe("");
    expect(brandTypographyCss({ heading: "", body: "   " })).toBe("");
  });

  it("emits the body-font rule on .jab-theme and the heading-font rule on h1–h6", () => {
    const css = brandTypographyCss({ heading: "Anton", body: "Source Sans Pro" });
    expect(css).toMatch(/\.jab-theme\s*\{\s*font-family:\s*"Source Sans Pro", ui-sans-serif, system-ui, sans-serif;\s*\}/);
    expect(css).toMatch(/\.jab-theme h1, \.jab-theme h2, \.jab-theme h3, \.jab-theme h4, \.jab-theme h5, \.jab-theme h6\s*\{\s*font-family:\s*"Anton", ui-sans-serif, system-ui, sans-serif;\s*\}/);
  });

  it("emits only the heading rule when body is absent (and vice versa)", () => {
    const headingOnly = brandTypographyCss({ heading: "Anton" });
    expect(headingOnly).toMatch(/h6\s*\{\s*font-family:\s*"Anton"/);
    expect(headingOnly).not.toMatch(/\.jab-theme\s*\{\s*font-family/);

    const bodyOnly = brandTypographyCss({ body: "Source Sans Pro" });
    expect(bodyOnly).toMatch(/\.jab-theme\s*\{\s*font-family:\s*"Source Sans Pro"/);
    expect(bodyOnly).not.toMatch(/h6/);
  });

  it("quotes family names safely (no injection via a crafted family)", () => {
    const css = brandTypographyCss({ body: 'Evil"}; body{display:none' });
    // JSON.stringify escapes the embedded quote so the rule can't break out.
    expect(css).toContain('font-family: "Evil\\"}; body{display:none", ui-sans-serif');
    expect(css).not.toMatch(/body\{display:none\}/);
  });
});

describe("compose-site-emit — theme.css", () => {
  it("returns empty string when stylesheets is empty", () => {
    expect(emitThemeCss([])).toBe("");
  });

  it("prefixes each selector with .jab-theme instead of nesting", () => {
    const src = emitThemeCss([
      { href: "https://x.test/style.css", css: ".btn { color: red; }" },
    ]);
    expect(src).toMatch(/\.jab-theme \.btn \{ color: red; \}/);
    // Old impl wrapped as `.jab-theme { .btn { ... } }` — that's invalid CSS.
    expect(src).not.toMatch(/\.jab-theme \{\s*\.btn/);
    expect(src).toMatch(/\/\* source: https:\/\/x\.test\/style\.css \*\//);
  });

  it("emits multiple sheets joined", () => {
    const src = emitThemeCss([
      { href: "https://x.test/a.css", css: ".a { color: red; }" },
      { href: "https://x.test/b.css", css: ".b { color: blue; }" },
    ]);
    expect(src).toMatch(/\.jab-theme \.a/);
    expect(src).toMatch(/\.jab-theme \.b/);
  });

  it("neutralizes */ in href to prevent CSS comment termination", () => {
    const src = emitThemeCss([
      { href: "https://x.test/a.css?q=*/body{color:red}/*", css: ".btn { color: red; }" },
    ]);
    const beforeScope = src.split(".jab-theme")[0];
    expect(beforeScope).not.toMatch(/\*\/\s*body\s*\{/);
  });
});

describe("compose-site-emit — absolutizeCssUrls (webpack build-gate fix)", () => {
  const base = "https://tworoadsbrewing.com/wp-content/themes/tworoads/assets/public/sass/app.css";

  it("rewrites a relative ../ font url to an absolute origin URL", () => {
    const out = absolutizeCssUrls("src: url(../bootstrap-icons.3536be6d.woff2)", base);
    expect(out).toContain(
      "url(https://tworoadsbrewing.com/wp-content/themes/tworoads/assets/public/bootstrap-icons.3536be6d.woff2)",
    );
    expect(out).not.toMatch(/url\(\.\.\//);
  });

  it("rewrites both quoted and unquoted relative urls and preserves quote style", () => {
    expect(absolutizeCssUrls(`src: url("./a.woff")`, base)).toContain(
      `url("https://tworoadsbrewing.com/wp-content/themes/tworoads/assets/public/sass/a.woff")`,
    );
    expect(absolutizeCssUrls(`src: url('./a.woff')`, base)).toContain(
      `url('https://tworoadsbrewing.com/wp-content/themes/tworoads/assets/public/sass/a.woff')`,
    );
  });

  it("leaves absolute http(s), protocol-relative, data, and fragment refs untouched", () => {
    const css = [
      "url(https://cdn.test/x.woff2)",
      "url(//cdn.test/y.woff)",
      "url(data:font/woff2;base64,AAAA)",
      "url(#mask-id)",
    ].join(" ");
    expect(absolutizeCssUrls(css, base)).toBe(css);
  });

  it("does not touch format() and only rewrites the url() in a @font-face src", () => {
    const src = `@font-face { src: url(../bi.woff2) format("woff2"), url(../bi.woff) format("woff"); }`;
    const out = absolutizeCssUrls(src, base);
    expect(out).toContain(`format("woff2")`);
    expect(out).toContain(`format("woff")`);
    expect(out).not.toMatch(/url\(\.\.\//);
    expect(out).toContain("url(https://tworoadsbrewing.com/wp-content/themes/tworoads/assets/public/bi.woff2)");
  });

  it("emitThemeCss absolutizes relative urls against each sheet's href", () => {
    const out = emitThemeCss([
      { href: base, css: `@font-face { font-family: bi; src: url(../bootstrap-icons.woff2); }` },
    ]);
    expect(out).not.toMatch(/url\(\.\.\//);
    expect(out).toContain("url(https://tworoadsbrewing.com/wp-content/themes/tworoads/assets/public/bootstrap-icons.woff2)");
  });
});

describe("compose-site-emit — scopeCssToJabTheme", () => {
  it("prefixes a plain selector with .jab-theme", () => {
    const out = scopeCssToJabTheme(".btn { color: red; }");
    expect(out).toMatch(/\.jab-theme \.btn \{ color: red; \}/);
  });

  it("rewrites html / body / :root to .jab-theme itself", () => {
    const out = scopeCssToJabTheme("body { background: #fff; } :root { --x: 1; }");
    expect(out).toMatch(/\.jab-theme \{ background: #fff; \}/);
    expect(out).toMatch(/\.jab-theme \{ --x: 1; \}/);
    expect(out).not.toMatch(/\.jab-theme body/);
    expect(out).not.toMatch(/\.jab-theme :root/);
  });

  it("hoists @font-face verbatim (does NOT prefix descendants)", () => {
    const out = scopeCssToJabTheme(`@font-face { font-family: "X"; src: url(x.woff2); }`);
    expect(out).toMatch(/@font-face \{ font-family: "X"; src: url\(x\.woff2\); \}/);
    expect(out).not.toMatch(/\.jab-theme.*@font-face/);
  });

  it("emits @keyframes verbatim without prefixing from/to", () => {
    const out = scopeCssToJabTheme(`@keyframes fade { from { opacity: 0 } to { opacity: 1 } }`);
    expect(out).toMatch(/@keyframes fade/);
    expect(out).not.toMatch(/\.jab-theme from/);
    expect(out).not.toMatch(/\.jab-theme to/);
  });

  it("recurses into @media and prefixes inner selectors", () => {
    const out = scopeCssToJabTheme(`@media (min-width: 768px) { .btn { color: red; } }`);
    expect(out).toMatch(/@media \(min-width: 768px\)/);
    expect(out).toMatch(/\.jab-theme \.btn \{ color: red; \}/);
  });

  it("splits selector lists on top-level commas and prefixes each", () => {
    const out = scopeCssToJabTheme(".a, .b { color: red; }");
    expect(out).toMatch(/\.jab-theme \.a, \.jab-theme \.b \{ color: red; \}/);
  });

  it("preserves commas inside :is() / :not() / [attr]", () => {
    const out = scopeCssToJabTheme(`:is(.a, .b) .c { color: red; }`);
    expect(out).toMatch(/\.jab-theme :is\(\.a, \.b\) \.c/);
    // Only ONE comma-split rule, not three
    expect(out.match(/\{/g)?.length).toBe(1);
  });

  it("strips /* … */ comments before scoping", () => {
    const out = scopeCssToJabTheme("/* skip me */ .btn { color: red; }");
    expect(out).not.toMatch(/skip me/);
    expect(out).toMatch(/\.jab-theme \.btn/);
  });

  it("strips !important so legacy utilities can't override #jab-app-scoped brand tokens", () => {
    // Bundled Bootstrap/Understrap CSS ships `.bg-primary{...!important}`.
    // Importance sorts BEFORE specificity in the cascade, so an !important legacy
    // rule beats the #jab-app-scoped brand-token utility (non-important) no matter
    // how high we push specificity — the captured brand color never wins. Demote
    // the legacy fallback layer by stripping !important; the #jab-app id-scope then
    // outranks `.jab-theme .bg-primary` (1,1,0 > 0,2,0) cleanly. This is the
    // companion to emitTailwindConfigTs's `important: "#jab-app"`.
    const out = scopeCssToJabTheme(".bg-primary { background-color: rgb(2,117,216) !important; }");
    expect(out).toContain(".jab-theme .bg-primary");
    expect(out).toContain("background-color: rgb(2,117,216)");
    expect(out).not.toMatch(/!\s*important/i);
  });

  it("strips !important regardless of whitespace/case, including inside @media", () => {
    expect(scopeCssToJabTheme(".x { color: red!important; }")).not.toMatch(/important/i);
    expect(scopeCssToJabTheme(".y { color: red ! IMPORTANT; }")).not.toMatch(/important/i);
    expect(
      scopeCssToJabTheme("@media (min-width:1px){ .z{display:none!important} }"),
    ).not.toMatch(/important/i);
  });

  it("drops body modifiers and keeps the descendant rule (body.home .hero)", () => {
    const out = scopeCssToJabTheme("body.home .hero { color: red; }");
    expect(out).toMatch(/\.jab-theme \.hero \{ color: red; \}/);
    // The .home modifier is dropped — it never matched the emitted body anyway.
    expect(out).not.toMatch(/\.jab-theme\.home/);
    expect(out).not.toMatch(/body/);
  });

  it("collapses html body chain to .jab-theme (html body .site)", () => {
    const out = scopeCssToJabTheme("html body .site { color: red; }");
    expect(out).toMatch(/\.jab-theme \.site \{ color: red; \}/);
    expect(out).not.toMatch(/\.jab-theme body/);
    expect(out).not.toMatch(/html/);
  });

  it("collapses :root body modifier chain (:root body.single .x)", () => {
    const out = scopeCssToJabTheme(":root body.single .x { color: red; }");
    expect(out).toMatch(/\.jab-theme \.x \{ color: red; \}/);
    expect(out).not.toMatch(/body/);
    expect(out).not.toMatch(/:root/);
  });

  it("strips leading html.no-js modifier (html.no-js .menu)", () => {
    const out = scopeCssToJabTheme("html.no-js .menu { display: block; }");
    expect(out).toMatch(/\.jab-theme \.menu \{ display: block; \}/);
    expect(out).not.toMatch(/no-js/);
  });

  it("solo body.X collapses to .jab-theme (no descendant)", () => {
    const out = scopeCssToJabTheme("body.home { background: blue; }");
    expect(out).toMatch(/\.jab-theme \{ background: blue; \}/);
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
    expect(src).toMatch(/<html lang="en" id="jab-app">/);
  });

  it("scopes the body with jab-theme so Header/Footer inherit theme.css", () => {
    const src = emitLayoutTsx("Site", null);
    expect(src).toMatch(/<body className="antialiased jab-theme">/);
  });

  it("anchors id=jab-app on <html> as the important-scope for Tailwind utilities", () => {
    // Pairs with emitTailwindConfigTs's `important: '#jab-app'`: the id must sit
    // on an ancestor of every utility-bearing element (html wraps body + chrome
    // + content) so `#jab-app .<utility>` (1,1,0) beats scoped legacy CSS (0,2,0).
    const src = emitLayoutTsx("Site", null);
    expect(src).toMatch(/<html lang="en" id="jab-app">/);
  });

  it("falls back to a default description when none provided", () => {
    const src = emitLayoutTsx("My Site", null);
    expect(src).toMatch(/description:\s+"Generated by JAB"/);
  });

  it("escapes quotes in project name + description", () => {
    const src = emitLayoutTsx('Sean\'s "Site"', 'It\'s great');
    expect(src).toMatch(/title:\s+"Sean's \\\"Site\\\""/);
  });

  // --- Font-link injection (tier-2 fidelity fix 2026-06-04) ---------------
  // Brand fonts loaded from non-theme hosts (Google Fonts) are dropped by
  // capture-theme-stylesheets (classify() === "other"). We re-inject them at
  // compose time from the captured fontFamily tokens via <link> tags that
  // React 19 hoists into <head>.

  it("omits all font links when no hrefs are supplied (byte-identical to pre-fix)", () => {
    const withArg = emitLayoutTsx("Site", null, []);
    const withoutArg = emitLayoutTsx("Site", null);
    // Back-compat: third arg defaults to [] → identical output.
    expect(withArg).toBe(withoutArg);
    expect(withArg).not.toMatch(/fonts\.googleapis\.com/);
    expect(withArg).not.toMatch(/preconnect/);
  });

  it("emits preconnect + a stylesheet link per supplied font href", () => {
    const src = emitLayoutTsx("Two Roads Brewing", "Craft beer", [
      "https://fonts.googleapis.com/css2?family=Anton&display=swap",
      "https://fonts.googleapis.com/css2?family=DM+Sans&display=swap",
    ]);
    expect(src).toMatch(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com"/);
    expect(src).toMatch(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossOrigin="anonymous"/);
    expect(src).toMatch(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Anton&display=swap"/);
    expect(src).toMatch(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=DM\+Sans&display=swap"/);
    // Shell + children still composed.
    expect(src).toMatch(/<Header\s*\/>/);
    expect(src).toMatch(/{children}/);
    expect(src).toMatch(/<Footer\s*\/>/);
  });
});

describe("compose-site-emit — buildGoogleFontLinks", () => {
  it("returns [] for null tokens", () => {
    expect(buildGoogleFontLinks(null)).toEqual([]);
  });

  it("returns [] when tokens carry no fontFamilies", () => {
    expect(buildGoogleFontLinks({ colorPalette: [{ slug: "y", color: "#ffc72c" }] })).toEqual([]);
  });

  it("derives a Google Fonts css2 href from a quoted primary family", () => {
    const tokens: ThemeJsonTokens = { fontFamilies: [{ slug: "heading", fontFamily: '"Anton", sans-serif' }] };
    expect(buildGoogleFontLinks(tokens)).toEqual([
      "https://fonts.googleapis.com/css2?family=Anton&display=swap",
    ]);
  });

  it("encodes multi-word family names with + separators", () => {
    const tokens: ThemeJsonTokens = { fontFamilies: [{ slug: "body", fontFamily: '"DM Sans", system-ui, sans-serif' }] };
    expect(buildGoogleFontLinks(tokens)).toEqual([
      "https://fonts.googleapis.com/css2?family=DM+Sans&display=swap",
    ]);
  });

  it("handles an unquoted family name", () => {
    const tokens: ThemeJsonTokens = { fontFamilies: [{ slug: "body", fontFamily: "Montserrat, sans-serif" }] };
    expect(buildGoogleFontLinks(tokens)).toEqual([
      "https://fonts.googleapis.com/css2?family=Montserrat&display=swap",
    ]);
  });

  it("drops generic + web-safe + system families (no Google request)", () => {
    const tokens: ThemeJsonTokens = {
      fontFamilies: [
        { slug: "a", fontFamily: "sans-serif" },
        { slug: "b", fontFamily: "Georgia, serif" },
        { slug: "c", fontFamily: "Arial, Helvetica, sans-serif" },
        { slug: "d", fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
        { slug: "e", fontFamily: '"Courier New", monospace' },
      ],
    };
    expect(buildGoogleFontLinks(tokens)).toEqual([]);
  });

  it("skips unresolved CSS-var / function references (FSE preset tokens)", () => {
    const tokens: ThemeJsonTokens = {
      fontFamilies: [
        { slug: "heading", fontFamily: "var(--wp--preset--font-family--anton)" },
        { slug: "body", fontFamily: '"DM Sans", sans-serif' },
      ],
    };
    expect(buildGoogleFontLinks(tokens)).toEqual([
      "https://fonts.googleapis.com/css2?family=DM+Sans&display=swap",
    ]);
  });

  it("dedupes families that resolve to the same primary name", () => {
    const tokens: ThemeJsonTokens = {
      fontFamilies: [
        { slug: "heading", fontFamily: '"Anton", sans-serif' },
        { slug: "display", fontFamily: "Anton" },
      ],
    };
    expect(buildGoogleFontLinks(tokens)).toEqual([
      "https://fonts.googleapis.com/css2?family=Anton&display=swap",
    ]);
  });

  it("emits one separate href per distinct family for fault isolation", () => {
    const tokens: ThemeJsonTokens = {
      fontFamilies: [
        { slug: "heading", fontFamily: '"Anton", sans-serif' },
        { slug: "body", fontFamily: '"DM Sans", sans-serif' },
      ],
    };
    const links = buildGoogleFontLinks(tokens);
    expect(links).toHaveLength(2);
    // Each family is its own request — a 400 on one bad family can't drop the others.
    expect(links.every((l) => /family=[^&]+&display=swap$/.test(l))).toBe(true);
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
  it("emits a Passthrough component without isomorphic-dompurify (ERR_REQUIRE_ESM guard)", () => {
    const src = emitPassthroughTsx();
    expect(src).not.toMatch(/isomorphic-dompurify/);
    expect(src).toMatch(/export function Passthrough/);
    // renders WP innerHTML directly — WP kses-filters at write time
    expect(src).toMatch(/__html.*html/);
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

describe("compose-site-emit — _dispatcher.tsx", () => {
  it("emits import + REGISTRY entry for every ok-status non-passthrough row", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "core/paragraph", tier: "trivial", compileStatus: "ok" },
      { blockName: "acf_flex/page/page_builder/large_hero", tier: "visual", compileStatus: "ok" },
    ]);
    expect(src).toMatch(/import \{ CoreHeading \} from "\.\/CoreHeading"/);
    expect(src).toMatch(/import \{ AcfFlexPagePageBuilderLargeHero \} from "\.\/AcfFlexPagePageBuilderLargeHero"/);
    expect(src).toMatch(/"core\/heading":\s*CoreHeading as unknown as ComponentType<BlockProps>/);
  });

  it("skips rows with compile_status = 'failed'", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "broken/block", tier: "visual", compileStatus: "failed" },
    ]);
    expect(src).toMatch(/"core\/heading":/);
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

  it("falls back to Passthrough with children for unknown blockName", () => {
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    expect(src).toMatch(/return <Passthrough block=\{block\}>\{children\}<\/Passthrough>/);
  });

  it("emits a valid file even when inventory is empty", () => {
    const src = emitDispatcherTsx([]);
    expect(src).toMatch(/export function BlockDispatcher/);
    expect(src).toMatch(/return <Passthrough/);
  });

  it("emitted TSX parses with ts.createSourceFile", async () => {
    const ts = await import("typescript");
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    const sf = ts.createSourceFile("_dispatcher.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });

  // Step 3 — prop contract tests
  it("imports RenderableBlock from @/lib/compose-block-tree", () => {
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    expect(src).toMatch(/import type \{ RenderableBlock \} from "@\/lib\/compose-block-tree"/);
  });

  it("does NOT import BlockNode from @/lib/sdk/types", () => {
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    expect(src).not.toMatch(/import type \{ BlockNode \}/);
  });

  it("dispatches via REGISTRY lookup with block={block} + children", () => {
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    // Component is resolved by lookup, then rendered with both block and children.
    expect(src).toMatch(/<C block=\{block\}>\{children\}<\/C>/);
    expect(src).not.toMatch(/\.\.\.(block\.attrs)/);
  });

  it("widens each REGISTRY entry through unknown as ComponentType<BlockProps>", () => {
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    expect(src).toMatch(/type BlockProps = \{ block: RenderableBlock; children\?: ReactNode \}/);
    expect(src).toMatch(/CoreHeading as unknown as ComponentType<BlockProps>/);
  });

  it("recurses into innerBlocks and passes pre-rendered children", () => {
    const src = emitDispatcherTsx([{ blockName: "core/group", tier: "standard", compileStatus: "ok" }]);
    expect(src).toMatch(/block\.innerBlocks/);
    expect(src).toMatch(/<BlockDispatcher key=\{inner\._key\} block=\{inner\} \/>/);
  });

  it("BlockDispatcher signature uses RenderableBlock not BlockNode", () => {
    const src = emitDispatcherTsx([]);
    expect(src).toMatch(/\{ block \}: \{ block: RenderableBlock \}/);
    expect(src).not.toMatch(/block: BlockNode/);
  });
});

describe("compose-site-emit — homepage", () => {
  it("emits app/page.tsx for a static front-page", () => {
    const src = emitHomepageTsx({
      slug: "home",
      abilityName: "jab/get-pages-by-slug",
      wrapperKey: "page",
      paradigms: ["acf_flex", "acf_template", "gutenberg"],
      postType: "page",
    });
    expect(src).toMatch(/import \{ jabClient \} from "@\/lib\/jab\/client"/);
    expect(src).toMatch(/import \{ BlockDispatcher \}/);
    expect(src).toMatch(/import \{ composeBlockTree \}/);
    expect(src).toMatch(/import \{ ACF_FLEX_FIELDS \}/);
    expect(src).toMatch(/export const revalidate = 60;/);
    expect(src).toMatch(/jabClient\.callAbility\("jab\/get-pages-by-slug",\s*\{\s*slug:\s*"home"/);
    expect(src).toMatch(/composeBlockTree\(\s*record as Parameters/);
  });

  it("throws on null slug", () => {
    expect(() =>
      emitHomepageTsx({ slug: null, abilityName: null, wrapperKey: null, paradigms: [], postType: "page" }),
    ).toThrow(/no static front-page/);
  });

  // Step 4 — composeBlockTree cast tests
  it("emitted page.tsx casts record with Parameters<typeof composeBlockTree>[0]", () => {
    const src = emitHomepageTsx({
      slug: "home",
      abilityName: "jab/get-page-by-slug",
      wrapperKey: "page",
      paradigms: ["gutenberg"],
      postType: "page",
    });
    expect(src).toMatch(/record as Parameters<typeof composeBlockTree>\[0\]/);
  });

  it("emitted page.tsx does NOT call composeBlockTree(record, without cast", () => {
    const src = emitHomepageTsx({
      slug: "home",
      abilityName: "jab/get-page-by-slug",
      wrapperKey: "page",
      paradigms: ["gutenberg"],
      postType: "page",
    });
    expect(src).not.toMatch(/composeBlockTree\(record,/);
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

  it("calls the by-slug ability with the LEAF segment, never the joined path", () => {
    const src = emitCatchAllPageTsx();
    // The WP plugin matches post_name exactly; post_name can never contain "/".
    expect(src).toContain("const leaf = slug[slug.length - 1];");
    expect(src).toContain("{ slug: leaf, include: { blocks: true } }");
    expect(src).not.toContain("{ slug: path, include: { blocks: true } }");
  });
});

describe("compose-site-emit — route-map.ts", () => {
  it("emits ROUTE_MAP with abilityName + postType + paradigms per path", () => {
    const src = emitRouteMapTs([
      { routePath: "/about", postType: "page", paradigms: ["acf_flex"], abilityName: "jab/get-pages-by-slug", wrapperKey: "page" },
      { routePath: "/beer/ipa", postType: "beer", paradigms: ["acf_template"], abilityName: "jab/get-beers-by-slug", wrapperKey: "beer" },
    ]);
    expect(src).toMatch(/export const ROUTE_MAP:\s*Record<string,/);
    expect(src).toMatch(/"about":\s*\{\s*abilityName:\s*"jab\/get-pages-by-slug",\s*wrapperKey:\s*"page",\s*postType:\s*"page"/);
    expect(src).toMatch(/"beer\/ipa":\s*\{\s*abilityName:\s*"jab\/get-beers-by-slug"/);
  });

  it("excludes the front-page route + strips leading slash", () => {
    const src = emitRouteMapTs([
      { routePath: "/", postType: "page", paradigms: [], abilityName: "jab/get-pages-by-slug", wrapperKey: "page" },
      { routePath: "/about", postType: "page", paradigms: [], abilityName: "jab/get-pages-by-slug", wrapperKey: "page" },
    ]);
    expect(src).not.toMatch(/"":/);
    expect(src).toMatch(/"about":/);
  });

  it("throws on duplicate route paths", () => {
    expect(() =>
      emitRouteMapTs([
        { routePath: "/about", postType: "page", paradigms: [], abilityName: "jab/get-pages-by-slug", wrapperKey: "page" },
        { routePath: "/about", postType: "story", paradigms: [], abilityName: "jab/get-stories-by-slug", wrapperKey: "story" },
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

describe("compose-site-emit — related-posts runtime", () => {
  it("emits a self-contained module exporting resolveRelationshipRefs with no @/ imports", () => {
    const src = emitRelatedPostsTs();
    expect(src).toMatch(/export async function resolveRelationshipRefs/);
    expect(src).toMatch(/export function isPostRef/);
    // self-contained: must not import from the generated-project alias.
    expect(src).not.toMatch(/from ["']@\//);
  });
});

describe("compose-site-emit — homepage wires render-time relation hydration", () => {
  it("awaits resolveRelationshipRefs between composeBlockTree and the dispatcher", () => {
    const src = emitHomepageTsx({
      slug: "home", abilityName: "jab/get-pages-by-slug", wrapperKey: "page",
      paradigms: ["acf_flex"], postType: "page",
    });
    expect(src).toMatch(/import \{ resolveRelationshipRefs, createWpMediaResolver \} from "@\/lib\/jab\/related-posts"/);
    expect(src).toMatch(/const blocks = composeBlockTree\(/);
    expect(src).toMatch(/await resolveRelationshipRefs\(blocks, \(name, input\) => jabClient\.callAbility\(name, input\), createWpMediaResolver\(\)\)/);
    // hydration (the await call) must run before the dispatcher map in the render
    // compare last occurrences: the await line vs. the JSX render use of BlockDispatcher
    expect(src.lastIndexOf("resolveRelationshipRefs")).toBeLessThan(src.lastIndexOf("BlockDispatcher"));
  });

  it("catch-all page wires the same hydration", () => {
    const src = emitCatchAllPageTsx();
    expect(src).toMatch(/import \{ resolveRelationshipRefs, createWpMediaResolver \} from "@\/lib\/jab\/related-posts"/);
    expect(src).toMatch(/const blocks = composeBlockTree\(/);
    expect(src).toMatch(/await resolveRelationshipRefs\(blocks, \(name, input\) => jabClient\.callAbility\(name, input\), createWpMediaResolver\(\)\)/);
    // hydration (the await call) must run before the dispatcher map in the render
    expect(src.lastIndexOf("resolveRelationshipRefs")).toBeLessThan(src.lastIndexOf("BlockDispatcher"));
  });
});

// Task 5 — emit the dynamic-lists runtime + DYNAMIC_LISTS map
describe("emitDynamicListsTs", () => {
  it("emits the runtime verbatim with resolveDynamicLists exported", () => {
    const out = emitDynamicListsTs();
    expect(out).toContain("export async function resolveDynamicLists");
    expect(out).not.toContain('from "@/'); // self-contained
  });
});

describe("emitDynamicListsMapTs", () => {
  it("emits a DYNAMIC_LISTS const keyed by blockName", () => {
    const out = emitDynamicListsMapTs([
      {
        blockName: "acf_flex/page/page_builder/upcoming_events",
        listAbility: "jab/get-event",
        wrapperKey: "event",
        postType: "event",
        dateField: "start_date__time",
        order: "asc",
        upcomingOnly: true,
        limit: 12,
      },
    ]);
    expect(out).toContain('import type { DynamicListSpec } from "./dynamic-lists";');
    expect(out).toContain("export const DYNAMIC_LISTS");
    expect(out).toContain('"acf_flex/page/page_builder/upcoming_events"');
    expect(out).toContain('"jab/get-event"');
  });

  it("emits an empty map when there are no dynamic lists", () => {
    expect(emitDynamicListsMapTs([])).toContain(
      "export const DYNAMIC_LISTS: Record<string, DynamicListSpec> = {};",
    );
  });
});

// Task 6 — page emitters wire the dynamic-list hydrator
describe("page emitters wire dynamic lists", () => {
  it("homepage imports + calls resolveDynamicLists after compose", () => {
    const src = emitHomepageTsx({
      slug: "home",
      abilityName: "jab/get-page-by-slug",
      wrapperKey: "page",
      paradigms: ["acf_flex"],
      postType: "page",
    });
    expect(src).toContain('import { resolveDynamicLists } from "@/lib/jab/dynamic-lists";');
    expect(src).toContain('import { DYNAMIC_LISTS } from "@/lib/jab/dynamic-lists-map";');
    expect(src).toContain(
      "await resolveDynamicLists(blocks, (name, input) => jabClient.callAbility(name, input), DYNAMIC_LISTS, createWpMediaResolver());",
    );
    // dynamic-list hydration runs after relation hydration and before the dispatcher
    expect(src.lastIndexOf("resolveRelationshipRefs")).toBeLessThan(src.lastIndexOf("resolveDynamicLists"));
    expect(src.lastIndexOf("resolveDynamicLists")).toBeLessThan(src.lastIndexOf("BlockDispatcher"));
  });

  it("catch-all imports + calls resolveDynamicLists after compose", () => {
    const src = emitCatchAllPageTsx();
    expect(src).toContain('import { resolveDynamicLists } from "@/lib/jab/dynamic-lists";');
    expect(src).toContain('import { DYNAMIC_LISTS } from "@/lib/jab/dynamic-lists-map";');
    expect(src).toContain("await resolveDynamicLists(blocks,");
    expect(src.lastIndexOf("resolveRelationshipRefs")).toBeLessThan(src.lastIndexOf("resolveDynamicLists"));
    expect(src.lastIndexOf("resolveDynamicLists")).toBeLessThan(src.lastIndexOf("BlockDispatcher"));
  });
});

describe("compose-site-emit — POST_TYPE_MAP", () => {
  const resolve = (postType: string) =>
    postType === "ghost"
      ? null
      : { abilityName: `jab/get-${postType}-by-slug`, wrapperKey: postType };

  it("groups pages by post_type, one entry each, sorted", () => {
    const entries = postTypeMapEntriesFromPages(
      [
        { post_type: "page", paradigms: ["gutenberg"] },
        { post_type: "page", paradigms: ["gutenberg"] },
        { post_type: "beer", paradigms: ["acf_flex"] },
      ],
      resolve,
    );
    expect(entries.map((e) => e.postType)).toEqual(["beer", "page"]);
    expect(entries[0]).toEqual({
      postType: "beer",
      abilityName: "jab/get-beer-by-slug",
      wrapperKey: "beer",
      paradigms: ["acf_flex"],
    });
  });

  it("omits post types with no resolvable by-slug ability", () => {
    const entries = postTypeMapEntriesFromPages(
      [{ post_type: "ghost", paradigms: [] }],
      resolve,
    );
    expect(entries).toEqual([]);
  });

  it("modalParadigms picks the most common set; ties go to first-seen", () => {
    expect(modalParadigms([["a"], ["b"], ["b"]])).toEqual(["b"]);
    expect(modalParadigms([["a"], ["b"]])).toEqual(["a"]);
    expect(modalParadigms([])).toEqual([]);
  });

  it("emits a typed record keyed by postType", () => {
    const src = emitPostTypeMapTs([
      { postType: "beer", abilityName: "jab/get-beer-by-slug", wrapperKey: "beer", paradigms: ["acf_flex"] },
    ]);
    expect(src).toContain(
      `"beer": { abilityName: "jab/get-beer-by-slug", wrapperKey: "beer", postType: "beer", paradigms: ["acf_flex"] },`,
    );
    expect(src).toContain(
      "export const POST_TYPE_MAP: Record<string, { abilityName: string; wrapperKey: string; postType: string; paradigms: string[] }>",
    );
  });

  it("emits an empty record for no entries", () => {
    expect(emitPostTypeMapTs([])).toContain("= {};");
  });
});
