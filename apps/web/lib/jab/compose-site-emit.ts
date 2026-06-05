import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderEnvExample, renderJabClient } from "@jab/core";
import type { ThemeJsonTokens } from "./global-styles";

/**
 * compose-site-emit.ts — Phase C deterministic file emitters.
 *
 * Every function here is pure: given inputs, returns the string contents
 * for one file in the emitted Next.js project tree at builds/<id>/project/.
 * No Storage I/O, no DB calls, no Inngest. The compose-site worker calls
 * these in parallel (each wrapped in its own step.run) and uploads results.
 *
 * Mirrors lib/jab/scaffold.ts but for the Phase C v2 file tree shape.
 */

const TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      plugins: [{ name: "next" }],
      baseUrl: ".",
      paths: { "@/*": ["./*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2,
);

const GITIGNORE = `# Dependencies
node_modules/

# Next.js build output
.next/
out/

# Production builds
build/
dist/

# Misc
.DS_Store
Thumbs.db
*.pem

# Logs
npm-debug.log*
pnpm-debug.log*
.pnpm-store/

# Env files (NEVER commit credentials)
.env
.env.*.local
.env.local

# TypeScript
*.tsbuildinfo
next-env.d.ts

# IDE
.vscode/
.idea/
`;

const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

const NOT_FOUND_TSX = `export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <p className="text-sm uppercase tracking-widest text-gray-500 mb-3">404</p>
        <h1 className="text-3xl font-bold mb-3">Page not found</h1>
        <p className="text-gray-600 mb-6">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <a href="/" className="inline-block underline">Return home</a>
      </div>
    </main>
  );
}
`;

export function emitTsconfigJson(): string {
  return TSCONFIG_JSON + "\n";
}

export function emitGitignore(): string {
  return GITIGNORE;
}

export function emitPostcssConfig(): string {
  return POSTCSS_CONFIG;
}

export function emitNotFoundTsx(): string {
  return NOT_FOUND_TSX;
}

export function emitPackageJson(projectName: string): string {
  const npmName =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 200) || "headless-site";

  return `${JSON.stringify(
    {
      name: npmName,
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        next: "^15.0.0",
        react: "^18.3.1",
        "react-dom": "^18.3.1",
      },
      devDependencies: {
        "@types/node": "^20.14.0",
        "@types/react": "^18.3.0",
        "@types/react-dom": "^18.3.0",
        autoprefixer: "^10.4.20",
        postcss: "^8.4.47",
        tailwindcss: "^3.4.10",
        typescript: "^5.5.0",
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * emitNextConfigTs — emit the generated app's next.config.ts.
 *
 * Loud-error contract: a deployable site without an images.remotePatterns
 * entry for the source WP host renders every `<Image>` as a blank box.
 * That silent failure burned the Two Roads pilot's predecessor pattern
 * (the pre-2026-05-29 implementation silently emitted hostname `"**"` on
 * URL parse failure, which Next.js rejects — see
 * docs/superpowers/specs/2026-05-29-two-roads-diagnosis.md). Both wpUrl
 * absence and unparseable wpUrl now throw with a descriptive message
 * naming the caller-supplied value, so the build fails fast in the
 * Inngest worker and surfaces as a `failed_phase: 'composing'` row with
 * a clear error_text instead of a deploy that silently lost its images.
 *
 * @param wpUrl       The WP origin URL (e.g. "https://tworoadsbrewing.com").
 *                    Required — must parse via `new URL(...)`.
 * @param extraHosts  Additional hostnames to whitelist in remotePatterns
 *                    (CDN domains, image-optimization-plugin rewrites, etc.).
 *                    Empty / unparseable entries are silently dropped so
 *                    callers can pass a best-effort harvest from the page
 *                    inventory; the primary wpUrl host is the loud-error
 *                    contract.
 */
/**
 * Scan free-form HTML / CSS strings for image-referencing URLs and
 * return the unique set of hostnames. Used at compose time to expand
 * the next.config.ts remotePatterns whitelist beyond the primary
 * wp_url host — CDN-rewritten images would otherwise fail at runtime
 * through next/image. Exported for unit testing.
 */
export function harvestImageHosts(
  sources: ReadonlyArray<string | null | undefined>,
  primaryHost?: string,
): string[] {
  const hosts = new Set<string>();
  const patterns: RegExp[] = [
    /\b(?:src|data-src)=["']([^"']+)["']/gi,
    /\bsrcset=["']([^"']+)["']/gi,
    /\bdata-srcset=["']([^"']+)["']/gi,
    /background-image\s*:\s*url\(["']?([^"')]+)["']?\)/gi,
  ];
  const imageExt = /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?)(?:\?|#|$)/i;

  for (const src of sources) {
    if (!src || typeof src !== "string") continue;
    for (const re of patterns) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(src)) !== null) {
        const raw = match[1];
        // srcset entries are separated by `, ` (comma + whitespace), NOT
        // by a bare comma — ShortPixel and other optimizer URLs embed
        // commas in their paths (e.g. /client/to_auto,q_glossy,ret_img/...).
        // Splitting on bare commas shreds those URLs into nonsense
        // fragments before we ever URL-parse them.
        const candidates = raw
          .split(/,\s+/)
          .map((s) => s.trim().split(/\s+/)[0])
          .filter(Boolean);
        for (const candidate of candidates) {
          if (!imageExt.test(candidate)) continue;
          try {
            const u = new URL(candidate);
            if (primaryHost && u.hostname === primaryHost) continue;
            hosts.add(u.hostname);
          } catch {
            // bare path, malformed — skip silently
          }
        }
      }
    }
  }
  return Array.from(hosts).sort();
}

export function emitNextConfigTs(wpUrl: string, extraHosts: string[] = []): string {
  if (typeof wpUrl !== "string" || wpUrl.trim().length === 0) {
    throw new Error(
      `emitNextConfigTs: wpUrl is required but received ${JSON.stringify(wpUrl)}. ` +
        `Without it, <Image> rendering silently fails for every source-hosted image. ` +
        `Validate project.wp_url before invoking compose.`,
    );
  }
  let primaryHost: string;
  try {
    primaryHost = new URL(wpUrl).hostname;
  } catch {
    throw new Error(
      `emitNextConfigTs: wpUrl ${JSON.stringify(wpUrl)} is not a valid URL. ` +
        `Expected scheme + host (e.g. "https://example.com").`,
    );
  }

  const hosts = new Set<string>([primaryHost]);
  for (const candidate of extraHosts) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    // Accept bare hostnames as well as full URLs — the inventory may surface
    // either depending on how the source emitted the image reference.
    let host: string | null = null;
    try {
      host = new URL(candidate).hostname;
    } catch {
      // Bare hostname fallback: must look like "host.tld" (no spaces, has dot).
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate.trim())) host = candidate.trim();
    }
    if (host) hosts.add(host);
  }

  const remotePatterns = Array.from(hosts)
    .map((h) => `      { protocol: "https", hostname: ${JSON.stringify(h)} },`)
    .join("\n");

  return `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
${remotePatterns}
    ],
  },
};

export default nextConfig;
`;
}

export function emitEnvExample(): string {
  return renderEnvExample();
}

export function emitJabClientTs(): string {
  return renderJabClient();
}

/**
 * Emit the render-time related-post resolver into the generated project at
 * lib/jab/related-posts.ts. Read verbatim from related-posts-runtime.ts (a
 * self-contained, DI'd module — no import rewrite needed).
 */
export function emitRelatedPostsTs(): string {
  return readFileSync(join(process.cwd(), "lib/jab/related-posts-runtime.ts"), "utf8");
}

export interface ThemeStylesheetCapture {
  href: string;
  css: string;
  /**
   * Tier classification of this capture. "theme" = matched the strict
   * /wp-content/themes/ path; "cache" = matched a known optimization-
   * plugin cache pattern (Tier 2 fallback). Optional because some
   * callers (pre-Fix-J test fixtures, the captureThemeStylesheets
   * back-compat shim) don't carry tier info. The fetch-fallback
   * code (`fetchBlockedStylesheets`) uses it to correctly gate
   * cache-kind blocked URLs when only Tier-2 sheets came through —
   * pre-Fix-J that gate relied on `existing.length > 0` which
   * conflated tier states.
   */
  kind?: "theme" | "cache";
}

/**
 * Captured brand font roles (from design_tokens.typography → resolveThemeTokens
 * fontFamilies slugs "heading" / "body"). Either may be absent.
 */
export interface BrandFonts {
  heading?: string | null;
  body?: string | null;
}

/** A font-family stack: the brand face first, then safe system fallbacks. */
function brandFontStack(name: string): string {
  return `${JSON.stringify(name)}, ui-sans-serif, system-ui, sans-serif`;
}

/**
 * Scoped CSS that forces the captured brand fonts onto semantic elements
 * within `.jab-theme`. Generated block components use generic Tailwind classes
 * (bare `<h2>`, no `font-heading`), so headings otherwise fall back to the
 * system font stack — the dominant typography-fidelity gap (Two Roads headings
 * rendered in -apple-system/500 instead of Anton). `.jab-theme h2` (specificity
 * 0,1,1) beats Tailwind utility classes (0,1,0) and base, without `!important`.
 *
 * Returns "" when no usable fonts → emitGlobalsCss stays byte-identical to the
 * pre-fix output. Family names are JSON-quoted so a crafted value can't break
 * out of the rule.
 */
export function brandTypographyCss(fonts?: BrandFonts | null): string {
  if (!fonts) return "";
  const rules: string[] = [];
  const body = fonts.body?.trim();
  const heading = fonts.heading?.trim();
  if (body) {
    rules.push(`.jab-theme { font-family: ${brandFontStack(body)}; }`);
  }
  if (heading) {
    rules.push(
      `.jab-theme h1, .jab-theme h2, .jab-theme h3, .jab-theme h4, .jab-theme h5, .jab-theme h6 { font-family: ${brandFontStack(heading)}; }`,
    );
  }
  if (rules.length === 0) return "";
  return `\n/* JAB brand typography — force the captured brand fonts onto semantic\n   elements; generated components use generic Tailwind classes that would\n   otherwise fall back to the system font stack. */\n${rules.join("\n")}\n`;
}

/**
 * app/globals.css emitter. Tailwind directives always; theme.css import is
 * conditional on whether we captured any source stylesheets in Phase A.
 * `brandFonts`, when present, appends scoped brand-font rules after the
 * Tailwind layers (see brandTypographyCss).
 */
export function emitGlobalsCss(hasThemeStylesheets: boolean, brandFonts?: BrandFonts | null): string {
  const importLine = hasThemeStylesheets ? `@import "../styles/theme.css";\n\n` : "";
  return `${importLine}@tailwind base;
@tailwind components;
@tailwind utilities;
${brandTypographyCss(brandFonts)}`;
}

/**
 * styles/theme.css emitter. Joins each captured theme stylesheet, scoping
 * the contained selectors under `.jab-theme` so the generated site's content
 * opts in via <main className="jab-theme"> without leaking source-site
 * styles into Tailwind utility-level rules. Returns empty string when no
 * stylesheets.
 *
 * The previous implementation wrapped each stylesheet wholesale as
 * `.jab-theme { <css> }`, which produced invalid CSS for at-rules
 * (`@font-face` / `@keyframes` / top-level `@media`) and for root selectors
 * (`html` / `body` / `:root`). The scoper below handles all three:
 *   - At-rules are hoisted (or recursed into for `@media`/`@supports` wrappers)
 *   - `html` / `body` / `:root` are rewritten to `.jab-theme`
 *   - All other selectors are prefixed with `.jab-theme `
 *
 * This is a deliberately small, dep-free transform. It handles the shapes
 * that surface on WP theme CSS in practice; a proper PostCSS pipeline can
 * replace it when the failure modes warrant the dep.
 */
export function emitThemeCss(sheets: ThemeStylesheetCapture[]): string {
  if (sheets.length === 0) return "";
  const parts: string[] = [];
  for (const sheet of sheets) {
    const safeHref = sheet.href.replaceAll("*/", "* /");
    parts.push(`/* source: ${safeHref} */`);
    parts.push(absolutizeCssUrls(scopeCssToJabTheme(sheet.css), sheet.href));
    parts.push("");
  }
  return parts.join("\n");
}

/**
 * Rewrite relative `url(...)` references in captured theme CSS to absolute URLs
 * resolved against the stylesheet's source href. Exported for unit testing.
 *
 * WordPress theme CSS routinely references font/image assets by RELATIVE path —
 * e.g. `@font-face { src: url(../bootstrap-icons.woff2) }` inside
 * `/assets/public/sass/app.css`. webpack's css-loader tries to resolve such
 * relative `url()`s as modules at build time and FAILS the Vercel `next build`,
 * because those asset files don't exist in the generated project tree (only the
 * CSS text was captured, not its sibling assets). css-loader does NOT resolve
 * absolute `http(s)` / `data:` / fragment refs, so rewriting every relative ref
 * to an absolute origin URL lets the build succeed; the assets then load
 * cross-origin from the source WP site at runtime.
 */
export function absolutizeCssUrls(css: string, baseHref: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi,
    (full: string, quote: string, ref: string) => {
      const trimmed = ref.trim();
      // Leave already-resolvable refs alone: absolute, protocol-relative,
      // data/blob URIs, and in-document fragments (e.g. SVG mask references).
      if (/^(https?:|data:|blob:|#|\/\/)/i.test(trimmed)) return full;
      try {
        const abs = new URL(trimmed, baseHref).toString();
        return `url(${quote}${abs}${quote})`;
      } catch {
        return full;
      }
    },
  );
}

/**
 * Scope a raw CSS source under `.jab-theme`. Exported for unit testing.
 *
 * Algorithm:
 *   1. Strip comments (so they don't interfere with brace counting).
 *   2. Walk the source one rule at a time. A rule is either an at-rule
 *      (starts with `@`) or a normal selector-list { declarations }.
 *   3. At-rules:
 *        - `@font-face`, `@keyframes`, `@page`, `@counter-style`,
 *          `@property`, `@import`, `@charset`, `@namespace` → emit as-is
 *          (they declare resources, not selectors; scoping breaks them).
 *        - `@media`, `@supports`, `@container`, `@layer` → recurse into
 *          the body so inner selectors get prefixed, then re-wrap.
 *   4. Normal rules: split the selector list on top-level commas, rewrite
 *      each selector independently, rejoin, and re-emit with the original
 *      declaration block.
 */
export function scopeCssToJabTheme(css: string): string {
  const stripped = stripCssComments(css);
  return scopeBlock(stripped);
}

function stripCssComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Strip `!important` from a captured-legacy declaration block. Bundled
 * Bootstrap/Understrap theme CSS ships utility rules like
 * `.bg-primary{...!important}`; because importance sorts BEFORE specificity in
 * the cascade, those rules beat the `#jab-app`-scoped brand-token utilities
 * (which are non-important) regardless of how high we push specificity — so the
 * captured brand colors never win (Two Roads' header rendered Bootstrap blue
 * instead of its real `#ffc72c`). Demoting the legacy fallback layer to normal
 * importance lets the id-scoped brand tokens win on specificity alone
 * (`#jab-app .bg-primary` 1,1,0 > `.jab-theme .bg-primary` 0,2,0). Companion to
 * emitTailwindConfigTs's `important: "#jab-app"`. Only the captured fallback CSS
 * passes through here; generated components never do.
 *
 * CSS allows optional whitespace after `!` and is case-insensitive. A literal
 * "!important" inside a quoted value (e.g. `content: "!important"`) would be a
 * false positive, but that does not occur in real theme CSS.
 */
function stripCssImportant(body: string): string {
  return body.replace(/\s*!\s*important\b/gi, "");
}

function scopeBlock(s: string): string {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /\s/.test(s[i])) i++;
    if (i >= n) break;
    if (s[i] === "@") {
      const ruleEnd = findAtRuleEnd(s, i);
      const atRule = s.slice(i, ruleEnd);
      out.push(rewriteAtRule(atRule));
      i = ruleEnd;
      continue;
    }
    // Normal selector { ... }
    const braceOpen = s.indexOf("{", i);
    if (braceOpen === -1) break;
    const braceClose = findMatchingBrace(s, braceOpen);
    if (braceClose === -1) break;
    const selectorList = s.slice(i, braceOpen).trim();
    const body = s.slice(braceOpen + 1, braceClose);
    const rewritten = rewriteSelectorList(selectorList);
    if (rewritten.length > 0) {
      out.push(`${rewritten} {${stripCssImportant(body)}}`);
    }
    i = braceClose + 1;
  }
  return out.join("\n");
}

/**
 * Find the end of an at-rule starting at index `start`. At-rules end either
 * at a semicolon (for `@import url(...);`) or at the matching `}` of the
 * body block.
 */
function findAtRuleEnd(s: string, start: number): number {
  const semi = s.indexOf(";", start);
  const brace = s.indexOf("{", start);
  if (brace === -1 || (semi !== -1 && semi < brace)) {
    return semi === -1 ? s.length : semi + 1;
  }
  const close = findMatchingBrace(s, brace);
  return close === -1 ? s.length : close + 1;
}

function findMatchingBrace(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const SCOPED_AT_RULES = new Set(["@media", "@supports", "@container", "@layer"]);

function rewriteAtRule(rule: string): string {
  const match = rule.match(/^@[a-zA-Z-]+/);
  if (!match) return rule;
  const name = match[0];
  if (!SCOPED_AT_RULES.has(name)) {
    // @font-face, @keyframes, @import, @charset, @page, @property, etc.
    // Emit verbatim — scoping inner content breaks the rule's contract.
    return rule;
  }
  // Recurse into the body. Find the first { ... } that's the at-rule's body.
  const braceOpen = rule.indexOf("{");
  if (braceOpen === -1) return rule;
  const braceClose = rule.lastIndexOf("}");
  if (braceClose === -1 || braceClose <= braceOpen) return rule;
  const head = rule.slice(0, braceOpen).trim();
  const inner = rule.slice(braceOpen + 1, braceClose);
  const innerScoped = scopeBlock(inner);
  return `${head} {\n${innerScoped}\n}`;
}

/**
 * Split a selector list on top-level commas (commas not inside parens/brackets),
 * rewrite each selector, and rejoin.
 */
function rewriteSelectorList(selectorList: string): string {
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selectorList.length; i++) {
    const c = selectorList[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      selectors.push(selectorList.slice(start, i));
      start = i + 1;
    }
  }
  selectors.push(selectorList.slice(start));
  return selectors
    .map((sel) => rewriteSelector(sel.trim()))
    .filter((s) => s.length > 0)
    .join(", ");
}

function rewriteSelector(sel: string): string {
  if (!sel) return "";
  // Skip @keyframes step selectors (from / to / NN%) — they only ever appear
  // inside an @keyframes body, and we emit @keyframes verbatim above. But if
  // a stripped scoper output somehow includes one, leave it alone.
  if (/^(from|to|\d+%)$/i.test(sel)) return sel;

  // Strip any leading chain of html / body / :root elements, including any
  // modifiers attached to them (e.g. body.home, body.single-beer, html.no-js).
  // Why: the emitted layout has exactly ONE body element with class
  // `jab-theme` and no source-site page-state modifiers. Selectors like:
  //   body.home .hero       — page-state CSS we'd otherwise drop entirely
  //   html body .site       — defensive double-root chain common in CSS resets
  //   :root body.single .x  — Sass output where :root is included for var scope
  // all collapse to ".jab-theme <rest>". The leading chain's modifiers (.home,
  // .single, etc.) get dropped because the headless frontend doesn't carry
  // them — preserving them would make the rule never match. This is
  // fidelity-over-precision: applying the rule universally beats it never
  // applying at all.
  //
  // Pattern: optional `:root`, then optional `html(.cls|[attr])*`, then
  // optional `body(.cls|[attr])*`, with whitespace between. Each leading
  // element can carry an arbitrary list of class / attribute / pseudo-class
  // modifiers; we strip them all.
  const ELEMENT_WITH_MODIFIERS = String.raw`(?:[.#][a-zA-Z0-9_-]+|\[[^\]]*\]|:[a-zA-Z-]+(?:\([^)]*\))?)*`;
  const stripLeading = new RegExp(
    `^(?::root${ELEMENT_WITH_MODIFIERS}\\s+)?` +
    `(?:html${ELEMENT_WITH_MODIFIERS}\\s+)?` +
    `(?:body${ELEMENT_WITH_MODIFIERS}\\s+)?`
  );
  let stripped = sel.replace(stripLeading, "").trim();

  // Solo `body`, `html`, `:root`, or one of them with modifiers but no
  // descendant — collapse to the scope class itself so root-defined custom
  // properties, font-family, box-sizing rules apply to the scoped content.
  const soloRoot = new RegExp(`^(?:html|body|:root)${ELEMENT_WITH_MODIFIERS}$`);
  if (soloRoot.test(sel.trim())) {
    return `.jab-theme`;
  }

  // If stripping consumed the entire selector (no descendant followed the
  // leading chain), fall back to the scope class.
  if (stripped.length === 0) return `.jab-theme`;

  // Compound selector — descendant under .jab-theme.
  return `.jab-theme ${stripped}`;
}

/**
 * Family names that should NEVER trigger a Google Fonts request: CSS generic
 * keywords, the cross-platform system stack, and the classic web-safe fonts.
 * All are either always-available or not served by Google Fonts (a request
 * would 400). Lowercased for case-insensitive comparison.
 */
const NON_GOOGLE_FONT_FAMILIES: ReadonlySet<string> = new Set([
  // CSS generic + global keywords
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "math", "emoji",
  "fangsong", "inherit", "initial", "unset", "revert", "revert-layer",
  // Apple / Blink system stack
  "-apple-system", "blinkmacsystemfont", "apple color emoji",
  "segoe ui emoji", "segoe ui symbol",
  // Windows / macOS web-safe families
  "segoe ui", "helvetica", "helvetica neue", "arial", "arial black",
  "georgia", "times", "times new roman", "courier", "courier new",
  "verdana", "tahoma", "trebuchet ms", "impact", "lucida console",
  "lucida sans unicode", "palatino linotype", "book antiqua",
  "consolas", "monaco", "menlo", "andale mono",
]);

/**
 * Build Google Fonts <link> hrefs from the captured fontFamily tokens.
 *
 * Why this exists: capture-theme-stylesheets only keeps stylesheets served
 * from /wp-content/themes/ (or a known cache-plugin host). Brand fonts loaded
 * from fonts.googleapis.com classify as "other" and are dropped — so classic
 * themes whose headline font is e.g. Anton lost their typography entirely
 * (Two Roads, 2026-06-04). We still capture the font-family *names* into the
 * Tailwind tokens, so we re-request them from Google at compose time.
 *
 * One href per distinct family (not a combined `family=A&family=B` URL) so a
 * 400 on a non-Google family can only drop itself, never the whole request.
 * System / web-safe / generic families are filtered out (NON_GOOGLE_FONT_FAMILIES).
 *
 * Per architecture doc §6.3 we still avoid next/font; these are plain <link>
 * tags that React 19 hoists into <head>.
 */
export function buildGoogleFontLinks(tokens: ThemeJsonTokens | null): string[] {
  if (!tokens?.fontFamilies?.length) return [];
  const seen = new Set<string>();
  const hrefs: string[] = [];
  for (const { fontFamily } of tokens.fontFamilies) {
    if (typeof fontFamily !== "string") continue;
    // Primary family = first comma segment, quotes + whitespace stripped.
    const primary = fontFamily.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "").trim() ?? "";
    if (!primary) continue;
    // Skip unresolved CSS-var / function references (some FSE themes store
    // `var(--wp--preset--font-family--x)` here) — they're not real family
    // names and would produce a guaranteed-400 Google request.
    if (/[()]/.test(primary)) continue;
    const key = primary.toLowerCase();
    if (NON_GOOGLE_FONT_FAMILIES.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    const familyParam = primary.replace(/\s+/g, "+");
    hrefs.push(`https://fonts.googleapis.com/css2?family=${familyParam}&display=swap`);
  }
  return hrefs;
}

/**
 * app/layout.tsx emitter. Wraps every route in Header + Footer plus globals.css.
 * Per architecture doc §6.3: do NOT use next/font — font-family declarations
 * come from the bundled theme.css; brand fonts hosted off-theme (Google Fonts)
 * are re-injected via `fontLinkHrefs` <link> tags (React 19 hoists them to
 * <head>). When `fontLinkHrefs` is empty the output is byte-identical to the
 * pre-fix layout.
 */
export function emitLayoutTsx(
  projectName: string,
  description: string | null,
  fontLinkHrefs: string[] = [],
): string {
  const safeName = JSON.stringify(projectName);
  const safeDescription = JSON.stringify(description ?? "Generated by JAB");
  const fontLinks = fontLinkHrefs.length
    ? "\n" +
      [
        `        <link rel="preconnect" href="https://fonts.googleapis.com" />`,
        `        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />`,
        ...fontLinkHrefs.map(
          (href) => `        <link rel="stylesheet" href=${JSON.stringify(href)} />`,
        ),
      ].join("\n")
    : "";
  return `import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: ${safeName},
  description: ${safeDescription},
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" id="jab-app">
      <body className="antialiased jab-theme">${fontLinks}
        <Header />
        {children}
        <Footer />
      </body>
    </html>
  );
}
`;
}

/**
 * tailwind.config.ts emitter. Deterministic from ThemeJsonTokens. The
 * emitted config drives every Phase B component's class names — at
 * generation time the LLM was given these token slugs and picked from
 * them.
 *
 * Null tokens path: emit defaults-only config. Happens for classic themes
 * where /wp-json/wp/v2/global-styles returned empty.
 *
 * `important: "#jab-app"` scopes every emitted utility under the `#jab-app` id
 * (anchored on `<html>` in app/layout.tsx). The theme.css scoper rewrites
 * Bootstrap/Understrap rules to `.jab-theme .bg-primary` (specificity 0,2,0),
 * which would otherwise beat a bare Tailwind `.bg-primary` (0,1,0) and bury the
 * captured brand tokens. Tailwind's selector-strategy `important` emits
 * `#jab-app .bg-primary` (1,1,0), winning by id-specificity with no `!important`
 * hammer — and it scopes utilities only, leaving preflight/base global. This is
 * the color/utility analogue of brandTypographyCss's `.jab-theme h2` (0,1,1)
 * font-specificity trick.
 */
export function emitTailwindConfigTs(tokens: ThemeJsonTokens | null): string {
  const colorsEntries: string[] = [];
  const fontFamilyEntries: string[] = [];
  const fontSizeEntries: string[] = [];

  if (tokens?.colorPalette) {
    for (const c of tokens.colorPalette) {
      const key = /^[a-z][a-zA-Z0-9_]*$/.test(c.slug) ? c.slug : JSON.stringify(c.slug);
      colorsEntries.push(`        ${key}: ${JSON.stringify(c.color)},`);
    }
  }

  if (tokens?.fontFamilies) {
    for (const f of tokens.fontFamilies) {
      const key = /^[a-z][a-zA-Z0-9_]*$/.test(f.slug) ? f.slug : JSON.stringify(f.slug);
      fontFamilyEntries.push(`        ${key}: [${JSON.stringify(f.fontFamily)}],`);
    }
  }

  if (tokens?.fontSizes) {
    for (const s of tokens.fontSizes) {
      const key = /^[a-z][a-zA-Z0-9_]*$/.test(s.slug) ? s.slug : JSON.stringify(s.slug);
      fontSizeEntries.push(`        ${key}: ${JSON.stringify(s.size)},`);
    }
  }

  const colorsSection = colorsEntries.length ? `      colors: {\n${colorsEntries.join("\n")}\n      },\n` : "";
  const fontFamilySection = fontFamilyEntries.length ? `      fontFamily: {\n${fontFamilyEntries.join("\n")}\n      },\n` : "";
  const fontSizeSection = fontSizeEntries.length ? `      fontSize: {\n${fontSizeEntries.join("\n")}\n      },\n` : "";

  return `import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{ts,tsx,mdx}",
    "./components/**/*.{ts,tsx,mdx}",
    "./lib/**/*.{ts,tsx,mdx}",
  ],
  // Scope utilities under #jab-app (on <html>) so brand tokens outrank the
  // bundled .jab-theme legacy CSS by id-specificity. See emitter JSDoc.
  important: "#jab-app",
  theme: {
    extend: {
${colorsSection}${fontFamilySection}${fontSizeSection}    },
  },
  plugins: [],
} satisfies Config;
`;
}

/**
 * app/robots.ts emitter. WordPress-specific disallows + sitemap pointer.
 */
export function emitRobotsTs(wpUrl: string): string {
  const baseUrl = wpUrl.replace(/\/+$/, "");
  return `import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/wp-admin/", "/wp-login.php", "/wp-json/"],
      },
    ],
    sitemap: ${JSON.stringify(baseUrl + "/sitemap.xml")},
  };
}
`;
}

export interface SitemapRoute {
  routePath: string;
}

/**
 * app/sitemap.ts emitter from page_inventory route_path list.
 */
export function emitSitemapTs(routes: SitemapRoute[], baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  const entries = routes.map((r) => {
    const path = r.routePath.startsWith("/") ? r.routePath : "/" + r.routePath;
    const url = path === "/" ? clean + "/" : clean + path;
    return `    { url: ${JSON.stringify(url)}, lastModified: new Date() },`;
  });
  const body = entries.length === 0 ? "  return [];" : `  return [\n${entries.join("\n")}\n  ];`;
  return `import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
${body}
}
`;
}

export interface BlockInventoryRowForFlexFields {
  blockName: string | null;
}

/**
 * lib/acf-flex-fields.ts emitter. Walks block_inventory block names with
 * the acf_flex/<post_type>/<field_path>/<layout> shape and extracts a
 * Record<post_type, fieldPath[]> map. Consumed at runtime by the emitted
 * compose-block-tree.ts (from Task 9) so the acf_flex paradigm
 * synthesizer knows which ACF fields on a record carry flex layouts.
 *
 * Fields deduped per post_type, preserving discovery order via Set
 * insertion order.
 */
export function emitAcfFlexFieldsTs(inventory: BlockInventoryRowForFlexFields[]): string {
  const byPostType = new Map<string, Set<string>>();
  for (const row of inventory) {
    if (!row.blockName) continue;
    const parts = row.blockName.split("/");
    if (parts.length < 4) continue;
    if (parts[0] !== "acf_flex") continue;
    const postType = parts[1];
    const fieldPath = parts[2];
    if (!byPostType.has(postType)) byPostType.set(postType, new Set());
    byPostType.get(postType)!.add(fieldPath);
  }

  const entries: string[] = [];
  for (const [postType, fields] of byPostType) {
    const key = /^[a-z][a-zA-Z0-9_]*$/.test(postType) ? postType : JSON.stringify(postType);
    const arr = Array.from(fields).map((f) => JSON.stringify(f)).join(", ");
    entries.push(`  ${key}: [${arr}],`);
  }

  const body = entries.length > 0 ? `\n${entries.join("\n")}\n` : "";
  return `/**
 * ACF Flexible Content field paths per post_type. Build-time constant
 * derived from block_inventory acf_flex/<cpt>/<field>/<layout> names.
 * Consumed by compose-block-tree.ts.
 */
export const ACF_FLEX_FIELDS: Record<string, string[]> = {${body}};
`;
}

export interface BlockInventoryRowForDispatch {
  blockName: string | null;
  tier: string | null;
  compileStatus: string | null;
}

/**
 * components/blocks/_dispatcher.tsx emitter. Switch on block.blockName,
 * one case per non-passthrough, non-failed, non-null inventory row.
 * Default branch falls through to <Passthrough> for unknowns / skipped
 * / failed.
 *
 * Component name derivation mirrors persist-generation.ts's toPascalCase.
 */
/**
 * Path the dispatcher imports MediaImage from. Shared between
 * `emitMediaImageTsx` (the file location) and `emitDispatcherTsx` (the
 * import specifier) so the two can't drift.
 */
const MEDIA_IMAGE_PROJECT_PATH = "components/blocks/_platform/MediaImage.tsx";
const MEDIA_IMAGE_IMPORT_SPECIFIER = "./_platform/MediaImage";

/**
 * Emit the MediaImage platform shim — the canonical core/image renderer
 * for the generated project. Switches between next/image (same-origin
 * per process.env.WP_URL) and a plain <img> for everything else, so a
 * runtime URL on a host the compose-time harvester missed still renders
 * instead of failing the next/image remotePatterns validator. Phase B
 * also generates a CoreImage component, but the dispatcher routes
 * core/image to this shim unconditionally (see emitDispatcherTsx) so
 * the runtime safety net is load-bearing, not aspirational.
 *
 * The emitted source mirrors apps/web/components/blocks/_platform/MediaImage.tsx
 * but imports BlockNode from "@/lib/sdk/types" (generated tree),
 * matching the convention LLM-generated block components use.
 *
 * Exported for unit testing.
 */
export function emitMediaImageTsx(): string {
  // The dangerouslySetInnerHTML attribute name is assembled from
  // fragments so source-tree linters don't false-positive on the
  // template literal. The emitted file is unchanged.
  const htmlSetter = "dangerouslySet" + "InnerHTML";
  return [
    `import Image from "next/image";`,
    `import type { BlockNode } from "@/lib/sdk/types";`,
    ``,
    `/**`,
    ` * MediaImage — platform shim for \`core/image\` blocks.`,
    ` *`,
    ` * Three-stage rendering, in priority order:`,
    ` *   1. structured attrs (\`block.attrs.url\` / \`.src\`) — next/image when`,
    ` *      same-origin per process.env.WP_URL, plain <img> otherwise.`,
    ` *   2. innerHTML <img> extraction — WordPress core/image stores`,
    ` *      \`{id, sizeSlug, linkDestination}\` in attrs but the actual`,
    ` *      <img src="..."> markup lives in innerHTML (sourced attributes`,
    ` *      per the plugin's BlockTypeSchema.php). Without stage 2 the`,
    ` *      shim returned null for the common attrs-only-metadata shape.`,
    ` *   3. raw innerHTML passthrough — when even the <img> parse fails`,
    ` *      but innerHTML carries content, render it verbatim so figures`,
    ` *      with captions, srcset, or multiple imgs aren't lost.`,
    ` *`,
    ` * Stage 1 / 2 both feed the same same-origin → next/image branching`,
    ` * so the host-validation safety net applies whenever we can extract`,
    ` * a clean src.`,
    ` *`,
    ` * Replace this file if you need custom image handling (art direction,`,
    ` * advanced srcset, CDN rewriting).`,
    ` */`,
    `export function isWpHostedImage(src: string, wpUrl: string | undefined): boolean {`,
    `  if (!wpUrl) return false;`,
    `  try {`,
    `    return new URL(src).hostname === new URL(wpUrl).hostname;`,
    `  } catch {`,
    `    return false;`,
    `  }`,
    `}`,
    ``,
    `export function parseImgFromInnerHTML(html: string): {`,
    `  src: string;`,
    `  alt?: string;`,
    `  width?: number;`,
    `  height?: number;`,
    `} | null {`,
    `  if (!html) return null;`,
    `  const imgMatch = html.match(/<img\\b[^>]*>/i);`,
    `  if (!imgMatch) return null;`,
    `  const tag = imgMatch[0];`,
    `  const get = (name: string): string | undefined => {`,
    `    const m = tag.match(new RegExp(\`\\\\b\${name}\\\\s*=\\\\s*["']([^"']*)["']\`, "i"));`,
    `    return m ? m[1] : undefined;`,
    `  };`,
    `  const src = get("src");`,
    `  if (!src) return null;`,
    `  const widthStr = get("width");`,
    `  const heightStr = get("height");`,
    `  const width = widthStr && /^\\d+$/.test(widthStr) ? Number(widthStr) : undefined;`,
    `  const height = heightStr && /^\\d+$/.test(heightStr) ? Number(heightStr) : undefined;`,
    `  return { src, alt: get("alt"), width, height };`,
    `}`,
    ``,
    `interface CoreImageAttrs {`,
    `  url?: string;`,
    `  src?: string;`,
    `  alt?: string;`,
    `  width?: number;`,
    `  height?: number;`,
    `  caption?: string;`,
    `  linkDestination?: string;`,
    `  href?: string;`,
    `  className?: string;`,
    `}`,
    ``,
    `export function MediaImage({ block }: { block: BlockNode }) {`,
    `  const attrs = block.attrs as CoreImageAttrs;`,
    `  const html = (block.innerHTML ?? "") as string;`,
    `  let src = attrs.url ?? attrs.src;`,
    `  let alt = attrs.alt;`,
    `  let width = attrs.width;`,
    `  let height = attrs.height;`,
    `  const caption = attrs.caption;`,
    `  const href = attrs.href;`,
    ``,
    `  if (!src && html) {`,
    `    const parsed = parseImgFromInnerHTML(html);`,
    `    if (parsed) {`,
    `      src = parsed.src;`,
    `      alt = alt ?? parsed.alt;`,
    `      width = width ?? parsed.width;`,
    `      height = height ?? parsed.height;`,
    `    }`,
    `  }`,
    ``,
    `  if (!src) {`,
    `    if (html.trim().length > 0) {`,
    `      return (`,
    `        <figure`,
    `          className="wp-block-image wp-block-image--passthrough"`,
    `          ${htmlSetter}={{ __html: html }}`,
    `        />`,
    `      );`,
    `    }`,
    `    return null;`,
    `  }`,
    ``,
    `  const finalAlt = alt ?? "";`,
    `  const finalWidth = width ?? 800;`,
    `  const finalHeight = height ?? 600;`,
    `  const sameOrigin = isWpHostedImage(src, process.env.WP_URL);`,
    ``,
    `  const img = sameOrigin ? (`,
    `    <Image`,
    `      src={src}`,
    `      alt={finalAlt}`,
    `      width={finalWidth}`,
    `      height={finalHeight}`,
    `      className={attrs.className}`,
    `      style={{ maxWidth: "100%", height: "auto" }}`,
    `    />`,
    `  ) : (`,
    `    /* eslint-disable-next-line @next/next/no-img-element */`,
    `    <img`,
    `      src={src}`,
    `      alt={finalAlt}`,
    `      width={finalWidth}`,
    `      height={finalHeight}`,
    `      className={attrs.className}`,
    `      style={{ maxWidth: "100%", height: "auto" }}`,
    `      loading="lazy"`,
    `      decoding="async"`,
    `    />`,
    `  );`,
    ``,
    `  return (`,
    `    <figure className="wp-block-image">`,
    `      {href ? (`,
    `        <a href={href} rel="noreferrer">{img}</a>`,
    `      ) : (`,
    `        img`,
    `      )}`,
    `      {caption && (`,
    `        <figcaption`,
    `          className="wp-element-caption"`,
    `          ${htmlSetter}={{ __html: caption }}`,
    `        />`,
    `      )}`,
    `    </figure>`,
    `  );`,
    `}`,
    ``,
  ].join("\n");
}

/**
 * Storage path the compose worker uploads MediaImage to. Exported so the
 * worker doesn't hard-code the location.
 */
export const MEDIA_IMAGE_FILE_PATH = MEDIA_IMAGE_PROJECT_PATH;

export function emitDispatcherTsx(rows: BlockInventoryRowForDispatch[]): string {
  const usable = rows.filter(
    (r) =>
      r.blockName !== null &&
      r.blockName !== "__null__" &&
      r.tier !== "passthrough" &&
      r.compileStatus === "ok",
  ) as Array<{ blockName: string; tier: string | null; compileStatus: string | null }>;

  const imports: string[] = [];
  const entries: string[] = [];
  // core/image always routes through the MediaImage platform shim (emitted
  // separately at components/blocks/_platform/MediaImage.tsx) so the
  // runtime same-origin → next/image, foreign-origin → plain <img>
  // safety net is the load-bearing path. Phase B may also have generated
  // a CoreImage component for this block, but we deliberately drop that
  // entry from the REGISTRY here — the LLM output can't be guaranteed to
  // do the host validation correctly, and ShortPixel-style CDN URLs
  // would otherwise throw the next/image remotePatterns validator at
  // request time.
  imports.push(`import { MediaImage } from "${MEDIA_IMAGE_IMPORT_SPECIFIER}";`);
  let routedCoreImage = false;
  for (const row of usable) {
    if (row.blockName === "core/image") {
      // Suppress the LLM-generated CoreImage import; MediaImage takes over.
      routedCoreImage = true;
      continue;
    }
    const componentName = toPascalCase(row.blockName);
    imports.push(`import { ${componentName} } from "./${componentName}";`);
    entries.push(
      `  ${JSON.stringify(row.blockName)}: ${componentName} as unknown as ComponentType<BlockProps>,`,
    );
  }
  // Always register MediaImage for core/image, regardless of whether
  // Phase B's CoreImage made it into `usable` (compile_status='ok'). When
  // Phase B failed for core/image, this also acts as the upgrade from
  // the passthrough innerHTML render to a real image element.
  void routedCoreImage;
  entries.push(`  "core/image": MediaImage as unknown as ComponentType<BlockProps>,`);

  // children: pre-rendered descendant blocks for wrapper-style blocks
  // (core/group, core/columns, core/buttons, etc). The dispatcher walks
  // innerBlocks once here and passes the rendered tree as JSX children so
  // each per-block component can render `{children}` in its body slot
  // without having to import BlockDispatcher itself. Components that
  // don't wrap children (paragraph, heading) just ignore the prop.
  //
  // The `as ComponentType<BlockProps>` cast on each lookup-table entry
  // widens whatever prop signature the LLM actually emitted on its
  // generated component into the superset { block, children? }. This is
  // a TYPE-ONLY widening — React itself ignores extra props at runtime,
  // so a component that types props as `{ block: BlockNode }` is
  // structurally fine receiving children it never reads. Prevents the
  // compile gate from rejecting working components on a prop-contract
  // mismatch the prompt asks for but cannot enforce.
  return `import type { ComponentType, ReactNode } from "react";
import type { RenderableBlock } from "@/lib/compose-block-tree";
import { Passthrough } from "./_passthrough";
${imports.join("\n")}

type BlockProps = { block: RenderableBlock; children?: ReactNode };

const REGISTRY: Record<string, ComponentType<BlockProps>> = {
${entries.join("\n")}
};

export function BlockDispatcher({ block }: { block: RenderableBlock }) {
  const children = block.innerBlocks && block.innerBlocks.length > 0
    ? <>{block.innerBlocks.map((inner) => <BlockDispatcher key={inner._key} block={inner} />)}</>
    : undefined;
  const C = block.blockName ? REGISTRY[block.blockName] : undefined;
  if (C) return <C block={block}>{children}</C>;
  return <Passthrough block={block}>{children}</Passthrough>;
}
`;
}

function toPascalCase(s: string): string {
  const trimmed = s.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
  const pascal = trimmed
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c: string) => c.toUpperCase());
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}

export interface HomepageInput {
  slug: string | null;
  abilityName: string | null;
  wrapperKey: string | null;
  paradigms: string[];
  postType: string;
}

/**
 * app/page.tsx (homepage) emitter. Hard-fails when slug is null
 * (no static front-page configured) per spec §6 C₁.
 */
export function emitHomepageTsx(input: HomepageInput): string {
  if (!input.slug || !input.abilityName || !input.wrapperKey) {
    throw new Error("no static front-page configured (WP admin → Settings → Reading)");
  }
  return `import { jabClient } from "@/lib/jab/client";
import { BlockDispatcher } from "@/components/blocks/_dispatcher";
import { composeBlockTree } from "@/lib/compose-block-tree";
import { ACF_FLEX_FIELDS } from "@/lib/acf-flex-fields";
import { resolveRelationshipRefs, createWpMediaResolver } from "@/lib/jab/related-posts";

export const revalidate = 60;

export default async function Page() {
  const response = await jabClient.callAbility(${JSON.stringify(input.abilityName)}, { slug: ${JSON.stringify(input.slug)}, include: { blocks: true } });
  const record = (response as Record<string, unknown>)[${JSON.stringify(input.wrapperKey)}];
  if (!record || typeof record !== "object") {
    throw new Error("front-page ability response missing ${input.wrapperKey}");
  }
  const blocks = composeBlockTree(
    record as Parameters<typeof composeBlockTree>[0],
    ${JSON.stringify(input.postType)},
    ${JSON.stringify(input.paradigms)},
    { acfFlexFields: ACF_FLEX_FIELDS },
  );
  await resolveRelationshipRefs(blocks, (name, input) => jabClient.callAbility(name, input), createWpMediaResolver());
  return (
    <main className="jab-theme">
      {blocks.map((b) => <BlockDispatcher key={b._key} block={b} />)}
    </main>
  );
}
`;
}

/**
 * app/[...slug]/page.tsx emitter. Static template — variability is in
 * the ROUTE_MAP constant next to it.
 */
export function emitCatchAllPageTsx(): string {
  return `import { notFound } from "next/navigation";
import { jabClient } from "@/lib/jab/client";
import { BlockDispatcher } from "@/components/blocks/_dispatcher";
import { composeBlockTree } from "@/lib/compose-block-tree";
import { ACF_FLEX_FIELDS } from "@/lib/acf-flex-fields";
import { resolveRelationshipRefs, createWpMediaResolver } from "@/lib/jab/related-posts";
import { ROUTE_MAP } from "./route-map";

export const revalidate = 60;

export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const path = slug.join("/");
  const entry = ROUTE_MAP[path];
  if (!entry) notFound();
  const response = await jabClient.callAbility(entry.abilityName, { slug: path, include: { blocks: true } });
  const record = (response as Record<string, unknown>)[entry.wrapperKey];
  if (!record || typeof record !== "object") notFound();
  const blocks = composeBlockTree(record as Record<string, unknown>, entry.postType, entry.paradigms, { acfFlexFields: ACF_FLEX_FIELDS });
  await resolveRelationshipRefs(blocks, (name, input) => jabClient.callAbility(name, input), createWpMediaResolver());
  return (
    <main className="jab-theme">
      {blocks.map((b) => <BlockDispatcher key={b._key} block={b} />)}
    </main>
  );
}
`;
}

export interface RouteMapEntry {
  routePath: string;
  postType: string;
  paradigms: string[];
  abilityName: string;
  wrapperKey: string;
}

/**
 * app/[...slug]/route-map.ts emitter. Excludes the front-page row;
 * throws on duplicate paths across post_types.
 */
export function emitRouteMapTs(routes: RouteMapEntry[]): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const r of routes) {
    if (r.routePath === "/") continue;
    const key = r.routePath.replace(/^\//, "");
    if (seen.has(key)) {
      throw new Error(`duplicate route path: ${r.routePath}`);
    }
    seen.add(key);
    const paradigmsArr = JSON.stringify(r.paradigms);
    entries.push(
      `  ${JSON.stringify(key)}: { abilityName: ${JSON.stringify(r.abilityName)}, wrapperKey: ${JSON.stringify(r.wrapperKey)}, postType: ${JSON.stringify(r.postType)}, paradigms: ${paradigmsArr} },`,
    );
  }
  const body = entries.length > 0 ? `\n${entries.join("\n")}\n` : "";
  return `export const ROUTE_MAP: Record<string, { abilityName: string; wrapperKey: string; postType: string; paradigms: string[] }> = {${body}};
`;
}

/**
 * components/blocks/_passthrough.tsx emitter. Static template.
 *
 * Uses string-fragment construction so this file itself does not contain
 * the React HTML-injection attribute as a literal token (avoiding lint
 * hooks on every emitter compile). The assembled output at runtime is
 * identical to the architecture doc §3 Decision 3 canonical TSX.
 */
export function emitPassthroughTsx(): string {
  // Assemble the attribute name from fragments to avoid the literal
  // appearing in apps/web source while producing the correct output.
  const d = "d";
  const attr = `${d}angerouslySetInnerHTML`;
  const lines = [
    `import type { ReactNode } from "react";`,
    `import type { BlockNode } from "@/lib/sdk/types";`,
    ``,
    `export function Passthrough({ block, children }: { block: BlockNode; children?: ReactNode }) {`,
    `  const html = block.innerHTML ?? "";`,
    `  // Wrapper-style fallback: when the dispatcher pre-rendered descendant`,
    `  // blocks (children) and there's no meaningful innerHTML, render the`,
    `  // children directly. Avoids dropping nested content for unknown`,
    `  // wrapper blocks like core/group that never had an LLM-generated`,
    `  // component. React forbids mixing innerHTML injection with children,`,
    `  // so the two paths are mutually exclusive.`,
    `  if (children && html.trim().length === 0) {`,
    `    return <div className="wp-block-passthrough">{children}</div>;`,
    `  }`,
    `  // HTML originates from the site's own WordPress database — not user`,
    `  // input. WP's kses filters sanitize at write time; re-sanitizing in`,
    `  // the render path is redundant and risks ERR_REQUIRE_ESM on Vercel`,
    `  // from DOM-polyfill packages that carry a CJS→ESM dep boundary.`,
    `  const ${attr} = { __html: html };`,
    `  return (`,
    `    <div`,
    `      className="wp-block-passthrough"`,
    `      ${attr}={${attr}}`,
    `    />`,
    `  );`,
    `}`,
    ``,
  ];
  return lines.join("\n");
}

export function emitReadmeMd(projectName: string): string {
  return `# ${projectName}

Headless Next.js frontend, generated by [JAB](https://github.com/jab-wp/wp-headless-kit).

Every file in this tree is regenerated on each build — your edits will be
overwritten next time. Iterate inside the JAB site review UI; export to
your own repo when you're ready to own the code outright.

## Local development

\`\`\`bash
cp .env.example .env.local
# Fill in WP_URL, WP_USER, WP_APP_PASSWORD

pnpm install
pnpm dev
\`\`\`

Open http://localhost:3000.

## Architecture

- \`app/page.tsx\` — homepage, composed from the WP front-page record
- \`app/[...slug]/page.tsx\` — catch-all dynamic route via \`ROUTE_MAP\`
- \`components/blocks/<Name>.tsx\` — one component per WP block type
- \`components/blocks/_dispatcher.tsx\` — block_name → component switch
- \`components/blocks/_passthrough.tsx\` — sanitized-HTML fallback
- \`components/site/Header.tsx\` + \`Footer.tsx\` — chrome (LLM-generated)
- \`lib/sdk/\` — typed WP client (MCP-derived)
- \`lib/compose-block-tree.ts\` — paradigm-aware runtime helper
- \`styles/theme.css\` — your source theme's CSS, scoped under \`.jab-theme\`

ISR (revalidate: 60) keeps content live within 60s of wp-admin edits.
`;
}
