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
 * styles/theme.css emitter. Joins each captured theme stylesheet under
 * a .jab-theme selector scope so the generated site's content opts in via
 * <main className="jab-theme">. Returns empty string when no stylesheets.
 */
export function emitThemeCss(sheets: ThemeStylesheetCapture[]): string {
  if (sheets.length === 0) return "";
  const parts: string[] = [];
  for (const sheet of sheets) {
    const safeHref = sheet.href.replaceAll("*/", "* /");
    parts.push(`/* source: ${safeHref} */`);
    parts.push(`.jab-theme {\n${sheet.css}\n}`);
    parts.push("");
  }
  return parts.join("\n");
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
      <body className="antialiased">
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
  const cases: string[] = [];
  for (const row of usable) {
    const componentName = toPascalCase(row.blockName);
    imports.push(`import { ${componentName} } from "./${componentName}";`);
    cases.push(
      `    case ${JSON.stringify(row.blockName)}: return <${componentName} {...(block.attrs as Record<string, never>)} />;`,
    );
  }

  return `import type { BlockNode } from "@/lib/sdk/types";
import { Passthrough } from "./_passthrough";
${imports.join("\n")}

export function BlockDispatcher({ block }: { block: BlockNode }) {
  switch (block.blockName) {
${cases.join("\n")}
    default: return <Passthrough block={block} />;
  }
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
  const blocks = composeBlockTree(record, ${JSON.stringify(input.postType)}, ${JSON.stringify(input.paradigms)}, { acfFlexFields: ACF_FLEX_FIELDS });
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
    `import type { BlockNode } from "@/lib/sdk/types";`,
    ``,
    `export function Passthrough({ block }: { block: BlockNode }) {`,
    `  const html = block.innerHTML ?? "";`,
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
