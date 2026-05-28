import "server-only";

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
