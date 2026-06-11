import "server-only";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { rewriteBlockNodeImports } from "@/lib/jab/import-rewrite";

/**
 * bundle — assembles the draft-runtime browser bundle:
 *   entry.tsx (real file) + virtual:dispatcher (emitDispatcherTsx output)
 *   + per-component TSX (Storage/DB sources) + shell + shims.
 *
 * SECURITY INVARIANT (spec §5/§7.4): esbuild PARSES the LLM-generated
 * sources; nothing here executes them. Execution happens only in the
 * user's browser inside the sandboxed draft iframe.
 *
 * This is also the per-edit compile gate: a component that fails to parse
 * or resolve fails the bundle, and the caller refuses to commit the draft
 * version (no broken previews).
 */
export interface DraftBundleInput {
  /** PascalCase component name -> TSX source (the dispatcher imports "./<Name>"). */
  componentSources: Record<string, string>;
  dispatcherSource: string;
  passthroughSource: string;
  headerSource: string | null;
  footerSource: string | null;
  wpUrl: string;
}

/** Mirror of compose-site-emit's private toPascalCase — dispatcher import names. */
export function draftComponentName(blockName: string): string {
  const trimmed = blockName.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
  const pascal = trimmed
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c: string) => c.toUpperCase());
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}

const RUNTIME_DIR = path.join(process.cwd(), "lib", "draft", "runtime");

const NULL_SHELL = (name: "Header" | "Footer") =>
  `export function ${name}() { return null; }`;

export async function bundleDraftRuntime(input: DraftBundleInput): Promise<{ js: string }> {
  const virtualSources = new Map<string, string>();
  virtualSources.set("virtual:dispatcher", input.dispatcherSource);
  virtualSources.set("virtual:shell-header", input.headerSource ?? NULL_SHELL("Header"));
  virtualSources.set("virtual:shell-footer", input.footerSource ?? NULL_SHELL("Footer"));
  virtualSources.set("./_passthrough", input.passthroughSource);
  for (const [name, tsx] of Object.entries(input.componentSources)) {
    virtualSources.set(`./${name}`, rewriteBlockNodeImports(tsx));
  }

  const ALIASES: Record<string, string> = {
    "next/image": path.join(RUNTIME_DIR, "next-image-shim.tsx"),
    "next/link": path.join(RUNTIME_DIR, "next-link-shim.tsx"),
    "./_platform/MediaImage": path.join(RUNTIME_DIR, "media-image.tsx"),
    "@/lib/sdk/types": path.join(RUNTIME_DIR, "sdk-types-stub.ts"),
    "@/lib/jab/ability-client": path.join(RUNTIME_DIR, "sdk-types-stub.ts"),
    "@/lib/compose-block-tree": path.join(RUNTIME_DIR, "sdk-types-stub.ts"),
    "@/lib/jab/rewrite-links": path.join(process.cwd(), "lib", "jab", "rewrite-links-runtime.ts"),
  };

  const virtualPlugin: Plugin = {
    name: "jab-draft-virtual",
    setup(b) {
      b.onResolve({ filter: /^virtual:/ }, (args) => ({ path: args.path, namespace: "jab-virtual" }));
      // Relative imports issued FROM a virtual module (dispatcher -> ./AcfHero,
      // dispatcher -> ./_passthrough) resolve back into the virtual map or aliases.
      b.onResolve({ filter: /^\.\// }, (args) => {
        if (args.namespace !== "jab-virtual") return null;
        if (ALIASES[args.path]) return { path: ALIASES[args.path] };
        if (virtualSources.has(args.path)) return { path: args.path, namespace: "jab-virtual" };
        return null;
      });
      b.onResolve({ filter: /^@\// }, (args) => {
        if (ALIASES[args.path]) return { path: ALIASES[args.path] };
        return null;
      });
      b.onResolve({ filter: /^next\// }, (args) => {
        if (ALIASES[args.path]) return { path: ALIASES[args.path] };
        return null;
      });
      b.onLoad({ filter: /.*/, namespace: "jab-virtual" }, (args) => {
        const contents = virtualSources.get(args.path);
        if (contents === undefined) {
          return { errors: [{ text: `draft bundle: no source for virtual module '${args.path}'` }] };
        }
        return { contents, loader: "tsx", resolveDir: RUNTIME_DIR };
      });
    },
  };

  const result = await build({
    entryPoints: [path.join(RUNTIME_DIR, "entry.tsx")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    minify: false,
    logLevel: "silent",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env.WP_URL": JSON.stringify(input.wpUrl),
      "process.env.WP_USER": JSON.stringify(""),
      "process.env.WP_APP_PASSWORD": JSON.stringify(""),
    },
    plugins: [virtualPlugin],
  });

  if (result.errors.length > 0) {
    throw new Error(`draft bundle failed: ${result.errors.map((e) => e.text).join("; ")}`);
  }
  const out = result.outputFiles?.[0];
  if (!out) throw new Error("draft bundle: esbuild produced no output");
  return { js: out.text };
}
