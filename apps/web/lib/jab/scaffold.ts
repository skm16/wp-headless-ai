import "server-only";
import {
  emitSdk,
  renderEnvExample,
  renderJabClient,
  renderNextConfig,
  renderProxyRoute,
  type Manifest,
} from "@jab/core";

/**
 * Build the full set of files that constitute a runnable Next.js scaffold
 * for an agency repo, keyed by path-from-repo-root.
 *
 * The set splits into three buckets:
 *
 *   1. SDK files (regenerated each time the manifest changes) — produced
 *      by @jab/core's emitSdk(). Live under lib/sdk/. Treat as read-only
 *      output.
 *
 *   2. Hand-crafted scaffolding (kit-policy files the agency owns and
 *      can edit) — lib/jab/client.ts, app/[[...slug]]/route.ts. From
 *      @jab/core's renderJabClient + renderProxyRoute. Written ONCE on
 *      first scaffold; subsequent runs leave them alone.
 *
 *   3. Static project chrome (package.json, tsconfig.json, app/layout.tsx,
 *      Tailwind config, etc.) — the bits create-next-app would otherwise
 *      provide. Kept here as inline templates because the SaaS worker
 *      can't run create-next-app and we want the project to be runnable
 *      after a `pnpm install` + `pnpm dev`.
 *
 * Output keys are paths from the repo root (forward slashes). Callers
 * pipe each entry through their write mechanism — the GitHub worker uses
 * a single Git Data API tree commit, the future CLI scaffold could write
 * to disk.
 */
export interface ScaffoldOptions {
  projectName: string;
  manifest: Manifest;
}

export async function buildScaffoldFiles(
  opts: ScaffoldOptions,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  // 1. SDK — regenerated from the manifest. emitSdk returns keys like
  //    "types.ts" / "client.ts" / "CLAUDE.md" → prefix to land under lib/sdk/.
  const sdkFiles = await emitSdk(opts.manifest);
  for (const [name, contents] of sdkFiles) {
    files.set(`lib/sdk/${name}`, contents);
  }

  // 2. Hand-crafted scaffolding owned by the agency post-init.
  files.set("lib/jab/client.ts", renderJabClient());
  files.set("app/[[...slug]]/route.ts", renderProxyRoute());

  // 3. Static project chrome.
  files.set("package.json", renderPackageJson(opts.projectName));
  files.set("tsconfig.json", TSCONFIG);
  files.set("next.config.ts", renderNextConfig());
  files.set("tailwind.config.ts", TAILWIND_CONFIG);
  files.set("postcss.config.mjs", POSTCSS_CONFIG);
  files.set(".gitignore", GITIGNORE);
  files.set(".env.example", renderEnvExample());
  files.set("README.md", renderReadme(opts.projectName));
  files.set("app/layout.tsx", renderRootLayout(opts.projectName));
  files.set("app/globals.css", GLOBALS_CSS);

  return files;
}

function renderPackageJson(projectName: string): string {
  // Slug-cased for npm name. npm names disallow uppercase + most punctuation.
  const npmName = projectName
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

const TSCONFIG = `${JSON.stringify(
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
)}\n`;

const TAILWIND_CONFIG = `import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{ts,tsx,mdx}",
    "./components/**/*.{ts,tsx,mdx}",
    "./lib/**/*.{ts,tsx,mdx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
`;

const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

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
yarn-debug.log*
yarn-error.log*
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

function renderReadme(projectName: string): string {
  return `# ${projectName}

Headless Next.js frontend, generated by [Jab](https://github.com/jab-wp/wp-headless-kit).

This repo is managed by Jab — pages on \`jab/*\` feature branches are AI-generated from your WordPress site. Merge to \`main\` when you're happy with what you see.

## Local development

\`\`\`bash
# 1. Clone this branch
git clone <this-repo-url> .
git checkout <feature-branch-name>   # e.g. jab/home-abc12345

# 2. Set up env vars
cp .env.example .env.local
# Fill in WP_URL, WP_USER, WP_APP_PASSWORD with your WordPress credentials.
# For Local by Flywheel / self-signed certs in dev, also uncomment
# NODE_TLS_REJECT_UNAUTHORIZED=0 in .env.local.

# 3. Install + run
pnpm install      # or npm install / yarn
pnpm dev

# 4. Open http://localhost:3000
\`\`\`

## What's regenerated vs. owned by you

| Path | Regenerated by Jab? | Edit it? |
|---|---|---|
| \`app/page.tsx\` | Each generation | Yes — but next gen will overwrite |
| \`lib/sdk/\` | Each manifest change | No — treat as read-only output |
| \`lib/jab/client.ts\` | One-time scaffold | Yes — yours after first run |
| \`app/[[...slug]]/route.ts\` | One-time scaffold | Yes — strangler-fig proxy, customize freely |
| Everything else | One-time scaffold | Yes |

## How the SDK works

The typed SDK in \`lib/sdk/\` is auto-generated from your WordPress site's MCP-exposed abilities. Server Components import \`jabClient\` from \`@/lib/jab/client\` (which wraps the SDK's \`createClient\` with environment-driven auth) and call typed functions like \`getJabPosts()\`, \`getJabPageBySlug()\`, etc.

See \`lib/sdk/CLAUDE.md\` for the full ability catalog and example usage.

## Strangler-fig proxy

\`app/[[...slug]]/route.ts\` is a catch-all that forwards unmatched routes to the URL in \`WP_PROXY_URL\` (set in \`.env.local\`). Useful for incremental migration: explicit Next.js routes win, everything else passes through to your existing WP site. Leave \`WP_PROXY_URL\` blank to disable.
`;
}

function renderRootLayout(projectName: string): string {
  // JSON-encode for safe embedding in the template literal.
  const safeName = JSON.stringify(projectName);
  return `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: ${safeName},
  description: "Generated by Jab",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
`;
}

const GLOBALS_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;
`;
