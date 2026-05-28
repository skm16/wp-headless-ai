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
