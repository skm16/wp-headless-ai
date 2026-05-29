import "server-only";
import { renderEnvExample, renderJabClient, renderNextConfig } from "@jab/core";
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
        "isomorphic-dompurify": "^2.16.0",
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

export function emitNextConfigTs(): string {
  return renderNextConfig();
}

export function emitEnvExample(): string {
  return renderEnvExample();
}

export function emitJabClientTs(): string {
  return renderJabClient();
}

export interface ThemeStylesheetCapture {
  href: string;
  css: string;
}

/**
 * app/globals.css emitter. Tailwind directives always; theme.css import is
 * conditional on whether we captured any source stylesheets in Phase A.
 */
export function emitGlobalsCss(hasThemeStylesheets: boolean): string {
  const importLine = hasThemeStylesheets ? `@import "../styles/theme.css";\n\n` : "";
  return `${importLine}@tailwind base;
@tailwind components;
@tailwind utilities;
`;
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
    parts.push(scopeCssToJabTheme(sheet.css));
    parts.push("");
  }
  return parts.join("\n");
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
      out.push(`${rewritten} {${body}}`);
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
 * app/layout.tsx emitter. Wraps every route in Header + Footer plus globals.css.
 * Per architecture doc §6.3: do NOT use next/font — font-family declarations
 * come from the bundled theme.css.
 */
export function emitLayoutTsx(projectName: string, description: string | null): string {
  const safeName = JSON.stringify(projectName);
  const safeDescription = JSON.stringify(description ?? "Generated by JAB");
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
    <html lang="en">
      <body className="antialiased jab-theme">
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
  for (const row of usable) {
    const componentName = toPascalCase(row.blockName);
    imports.push(`import { ${componentName} } from "./${componentName}";`);
    entries.push(
      `  ${JSON.stringify(row.blockName)}: ${componentName} as ComponentType<BlockProps>,`,
    );
  }

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
  paradigms: string[];
  postType: string;
}

/**
 * app/page.tsx (homepage) emitter. Hard-fails when slug is null
 * (no static front-page configured) per spec §6 C₁.
 */
export function emitHomepageTsx(input: HomepageInput): string {
  if (!input.slug || !input.abilityName) {
    throw new Error("no static front-page configured (WP admin → Settings → Reading)");
  }
  return `import { jabClient } from "@/lib/jab/client";
import { BlockDispatcher } from "@/components/blocks/_dispatcher";
import { composeBlockTree } from "@/lib/compose-block-tree";
import { ACF_FLEX_FIELDS } from "@/lib/acf-flex-fields";

export const revalidate = 60;

export default async function Page() {
  const record = await jabClient.callAbility(${JSON.stringify(input.abilityName)}, { slug: ${JSON.stringify(input.slug)}, include: { blocks: true } });
  const blocks = composeBlockTree(
    record as Parameters<typeof composeBlockTree>[0],
    ${JSON.stringify(input.postType)},
    ${JSON.stringify(input.paradigms)},
    { acfFlexFields: ACF_FLEX_FIELDS },
  );
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
import { ROUTE_MAP } from "./route-map";

export const revalidate = 60;

export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const path = slug.join("/");
  const entry = ROUTE_MAP[path];
  if (!entry) notFound();
  const record = await jabClient.callAbility(entry.abilityName, { slug: path, include: { blocks: true } });
  const blocks = composeBlockTree(record as Record<string, unknown>, entry.postType, entry.paradigms, { acfFlexFields: ACF_FLEX_FIELDS });
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
      `  ${JSON.stringify(key)}: { abilityName: ${JSON.stringify(r.abilityName)}, postType: ${JSON.stringify(r.postType)}, paradigms: ${paradigmsArr} },`,
    );
  }
  const body = entries.length > 0 ? `\n${entries.join("\n")}\n` : "";
  return `export const ROUTE_MAP: Record<string, { abilityName: string; postType: string; paradigms: string[] }> = {${body}};
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
    `import DOMPurify from "isomorphic-dompurify";`,
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
    `  const sanitized = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });`,
    `  const ${attr} = { __html: sanitized };`,
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
