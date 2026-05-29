import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { emitSdk } from "@jab/core";
import { modelClientForTier } from "@/lib/ai/model-client";
import { generateShell } from "@/lib/ai/generate-shell";
import { persistShellGeneration } from "@/lib/ai/persist-shell-generation";
import { extractThemeClassNames } from "@/lib/ai/shell-prompts";
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
  emitDispatcherTsx,
  emitHomepageTsx,
  emitCatchAllPageTsx,
  emitRouteMapTs,
  emitReadmeMd,
  type ThemeStylesheetCapture,
} from "@/lib/jab/compose-site-emit";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
import { rewriteBlockNodeImports } from "@/lib/jab/import-rewrite";
import { compileGeneratedProject } from "@/lib/jab/compile-generated-project";

/**
 * compose-site — Phase C Inngest worker.
 *
 * Triggered by site/compose.requested (dispatched by generateComponents on
 * clean exit). Status machine: 'composing' on entry → 'built' on clean exit
 * → dispatches site/deploy.requested.
 *
 * Three-wave step.run sequencing (spec §5):
 *   Wave 1 (parallel): all deterministic emissions.
 *   Wave 2 (parallel): component downloads + Header LLM + Footer LLM.
 *   Wave 3 (serial): layout.tsx → compile-gate → mark-built → dispatch deploy.
 *   (layout must precede the gate so tsc sees the full tree it'd deploy.)
 *
 * retries: 0 — same rationale as discoverSite + generateComponents.
 */

interface PageInventoryRow {
  slug: string;
  post_type: string;
  route_path: string;
  paradigms: string[];
}

interface BlockInventoryRowForCompose {
  block_name: string;
  tier: string | null;
  compile_status: string | null;
}

interface ManifestAbility {
  name: string;
  output_schema?: {
    required?: unknown;
  };
}

interface ManifestShape {
  abilities?: ManifestAbility[];
}

/**
 * Encode Next.js dynamic-route bracket segments to Storage-safe names.
 * Supabase Storage object keys allow only [A-Za-z0-9-_./], rejecting
 * the `[`, `]`, `.` (in `[...slug]`) chars Next.js uses for dynamic
 * routes. Phase D's deploy worker reverses this at write-to-disk time:
 *   __catchall_X__   ↔ [...X]
 *   __optcatchall_X__ ↔ [[...X]]
 *   __dynamic_X__    ↔ [X]
 * The encoding is regex-reversible. Source TS imports (e.g. `./route-map`
 * relative imports) are unaffected — those are module references, not
 * file paths.
 */
function encodeNextDynamicSegments(filePath: string): string {
  return filePath
    .replace(/\[\[\.\.\.([A-Za-z0-9_]+)\]\]/g, "__optcatchall_$1__")
    .replace(/\[\.\.\.([A-Za-z0-9_]+)\]/g, "__catchall_$1__")
    .replace(/\[([A-Za-z0-9_]+)\]/g, "__dynamic_$1__");
}

const PROJECT_PATH = (buildId: string, filePath: string) =>
  `builds/${buildId}/project/${encodeNextDynamicSegments(filePath)}`;

const COMPONENT_PATH = (buildId: string, fileName: string) =>
  `builds/${buildId}/components/${fileName}`;

/**
 * Resolves the registered ability name for a CPT's single-by-slug fetch.
 * JAB plugin convention is jab/get-{post_type}-by-slug — singular form
 * regardless of plural rest_base (verified against Two Roads manifest:
 * jab/get-page-by-slug, jab/get-beer-by-slug, etc.). Pluralized form
 * kept as a defensive fallback in case a custom plugin variant emits it.
 * Returns null if no matching ability is registered — caller treats that
 * as a hard error (homepage) or a warn+skip (route-map entries).
 */
function abilityMetaFor(
  postType: string,
  manifest: ManifestShape,
): { abilityName: string; wrapperKey: string } | null {
  const abilities = manifest.abilities ?? [];
  const plural = postType.endsWith("s") ? postType : postType + "s";
  for (const candidate of [
    `jab/get-${postType}-by-slug`,
    `jab/get-${plural}-by-slug`,
  ]) {
    const ability = abilities.find((a) => a.name === candidate);
    if (ability) {
      const required = ability.output_schema?.required;
      const wrapperKey = Array.isArray(required) && typeof required[0] === "string"
        ? required[0]
        : postType.replace(/-/g, "_");
      return { abilityName: candidate, wrapperKey };
    }
  }
  return null;
}

export const composeSite = inngest.createFunction(
  { id: "compose-site", retries: 0 },
  { event: "site/compose.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, buildId } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
    };

    await step.run("mark-composing-phase", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("site_builds")
        .update({ status: "composing" })
        .eq("id", buildId)
        .eq("project_id", projectId);
      if (error) throw new Error(`mark-composing-phase failed: ${error.message}`);
    });

    // Load inputs in parallel
    const [inventoryRows, pageRows, project, buildConfig] = await Promise.all([
      step.run("load-inventory", async (): Promise<BlockInventoryRowForCompose[]> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("block_inventory")
          .select("block_name, tier, compile_status")
          .eq("site_build_id", buildId)
          .eq("project_id", projectId);
        if (error) throw new Error(`load-inventory failed: ${error.message}`);
        return (data ?? []) as BlockInventoryRowForCompose[];
      }),
      step.run("load-pages", async (): Promise<PageInventoryRow[]> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("page_inventory")
          .select("slug, post_type, route_path, paradigms")
          .eq("site_build_id", buildId);
        if (error) throw new Error(`load-pages failed: ${error.message}`);
        return (data ?? []) as PageInventoryRow[];
      }),
      step.run("load-project", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("projects")
          .select("name, wp_url, design_tokens, manifest, logo_storage_path")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single();
        if (error || !data) throw new Error(`load-project failed: ${error?.message ?? "no row"}`);
        return data as {
          name: string;
          wp_url: string;
          design_tokens: unknown;
          manifest: unknown;
          logo_storage_path: string | null;
        };
      }),
      step.run("load-build-config", async (): Promise<{ front_page_slug?: string }> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("site_builds")
          .select("config")
          .eq("id", buildId)
          .single();
        if (error || !data) throw new Error(`load-build-config failed: ${error?.message ?? "no row"}`);
        return (data.config ?? {}) as { front_page_slug?: string };
      }),
    ]);

    const designTokens = (project.design_tokens ?? {}) as {
      themeJson?: ThemeJsonTokens;
      themeStylesheets?: ThemeStylesheetCapture[];
      shellDom?: { header: string | null; footer: string | null };
      personality?: { description?: string | null };
    };
    const themeTokens = designTokens.themeJson ?? null;
    const themeStylesheets = designTokens.themeStylesheets ?? [];
    const hasThemeCss = themeStylesheets.length > 0;
    const description = designTokens.personality?.description ?? null;
    const wpUrl = project.wp_url;

    const manifest = (project.manifest ?? {}) as ManifestShape;

    // Front-page resolution: config override first (matches the WP admin
    // → Settings → Reading "static front page" choice when Phase A can't
    // detect it), then fall back to any page_inventory row with route_path
    // === "/". Hard-fail if neither resolves — Phase D needs a homepage.
    let frontPage = buildConfig.front_page_slug
      ? pageRows.find((p) => p.slug === buildConfig.front_page_slug && p.post_type === "page")
      : undefined;
    if (!frontPage) {
      frontPage = pageRows.find((p) => p.route_path === "/");
    }
    if (!frontPage) {
      throw new Error(
        buildConfig.front_page_slug
          ? `compose-site: config.front_page_slug='${buildConfig.front_page_slug}' but no matching page in page_inventory.`
          : "compose-site: no static front-page configured. Set site_builds.config.front_page_slug or ensure Phase A populates a row with route_path='/'.",
      );
    }
    const frontPageSlug = frontPage.slug;

    // Correction 2: derive ability name from manifest, hard-fail if null
    const frontPageAbility = abilityMetaFor(frontPage.post_type, manifest);
    if (!frontPageAbility) {
      throw new Error(
        `no jab/get-<rest_base>-by-slug ability registered for front-page post_type '${frontPage.post_type}'`,
      );
    }

    // Wave 1: parallel deterministic emissions
    const uploads: Array<Promise<unknown>> = [];

    uploads.push(step.run("emit-tsconfig", () => uploadToProject(buildId, "tsconfig.json", emitTsconfigJson())));
    uploads.push(step.run("emit-gitignore", () => uploadToProject(buildId, ".gitignore", emitGitignore())));
    uploads.push(step.run("emit-postcss", () => uploadToProject(buildId, "postcss.config.mjs", emitPostcssConfig())));
    uploads.push(step.run("emit-not-found", () => uploadToProject(buildId, "app/not-found.tsx", emitNotFoundTsx())));
    uploads.push(step.run("emit-next-config", () => uploadToProject(buildId, "next.config.ts", emitNextConfigTs(project.wp_url))));
    uploads.push(step.run("emit-env-example", () => uploadToProject(buildId, ".env.example", emitEnvExample())));
    uploads.push(step.run("emit-package-json", () => uploadToProject(buildId, "package.json", emitPackageJson(project.name))));
    uploads.push(step.run("emit-readme", () => uploadToProject(buildId, "README.md", emitReadmeMd(project.name))));
    uploads.push(step.run("emit-tailwind", () => uploadToProject(buildId, "tailwind.config.ts", emitTailwindConfigTs(themeTokens))));
    uploads.push(step.run("emit-globals-css", () => uploadToProject(buildId, "app/globals.css", emitGlobalsCss(hasThemeCss))));
    if (hasThemeCss) {
      uploads.push(step.run("emit-theme-css", () => uploadToProject(buildId, "styles/theme.css", emitThemeCss(themeStylesheets))));
    }
    uploads.push(step.run("emit-robots", () => uploadToProject(buildId, "app/robots.ts", emitRobotsTs(wpUrl))));
    uploads.push(
      step.run("emit-sitemap", () =>
        uploadToProject(buildId, "app/sitemap.ts", emitSitemapTs(pageRows.map((p) => ({ routePath: p.route_path })), wpUrl)),
      ),
    );
    uploads.push(step.run("emit-passthrough", () => uploadToProject(buildId, "components/blocks/_passthrough.tsx", emitPassthroughTsx())));
    uploads.push(
      step.run("emit-dispatcher", () =>
        uploadToProject(
          buildId,
          "components/blocks/_dispatcher.tsx",
          emitDispatcherTsx(
            inventoryRows.map((r) => ({
              blockName: r.block_name === "__null__" ? null : r.block_name,
              tier: r.tier,
              compileStatus: r.compile_status,
            })),
          ),
        ),
      ),
    );
    uploads.push(step.run("emit-catch-all", () => uploadToProject(buildId, "app/[...slug]/page.tsx", emitCatchAllPageTsx())));

    // Correction 3: use abilityNameFor per-page, skip pages with no ability (warn + omit).
    // Also exclude the resolved front-page slug — it ships as app/page.tsx via emitHomepageTsx,
    // so including it in ROUTE_MAP would render the same content at two different URLs.
    uploads.push(
      step.run("emit-route-map", () =>
        uploadToProject(
          buildId,
          "app/[...slug]/route-map.ts",
          emitRouteMapTs(
            pageRows
              .filter((p) => !(p.post_type === "page" && p.slug === frontPageSlug))
              .map((p) => {
                const ability = abilityMetaFor(p.post_type, manifest);
                if (!ability) {
                  console.warn(
                    `[compose-site] no by-slug ability for post_type '${p.post_type}' — route ${p.route_path} omitted from ROUTE_MAP`,
                  );
                }
                return ability
                  ? { routePath: p.route_path, postType: p.post_type, paradigms: p.paradigms, abilityName: ability.abilityName, wrapperKey: ability.wrapperKey }
                  : null;
              })
              .filter(
                (e): e is { routePath: string; postType: string; paradigms: string[]; abilityName: string; wrapperKey: string } =>
                  e !== null,
              ),
          ),
        ),
      ),
    );

    // Correction 2: use abilityName field (was: fetcher) per Task 12 fix
    uploads.push(
      step.run("emit-homepage", () =>
        uploadToProject(
          buildId,
          "app/page.tsx",
          emitHomepageTsx({
            slug: frontPage.slug,
            abilityName: frontPageAbility.abilityName,
            wrapperKey: frontPageAbility.wrapperKey,
            paradigms: frontPage.paradigms,
            postType: frontPage.post_type,
          }),
        ),
      ),
    );
    uploads.push(
      step.run("emit-acf-flex-fields", () =>
        uploadToProject(
          buildId,
          "lib/acf-flex-fields.ts",
          emitAcfFlexFieldsTs(
            inventoryRows.map((r) => ({ blockName: r.block_name === "__null__" ? null : r.block_name })),
          ),
        ),
      ),
    );
    uploads.push(
      step.run("emit-compose-block-tree", () => {
        const runtimeSrc = readFileSync(
          join(process.cwd(), "lib/jab/compose-block-tree-runtime.ts"),
          "utf8",
        );
        const substituted = rewriteBlockNodeImports(runtimeSrc);
        return uploadToProject(buildId, "lib/compose-block-tree.ts", substituted);
      }),
    );
    uploads.push(step.run("emit-jab-client", () => uploadToProject(buildId, "lib/jab/client.ts", emitJabClientTs())));
    uploads.push(
      step.run("emit-sdk", async () => {
        const sdkManifest = project.manifest as Parameters<typeof emitSdk>[0];
        const files = await emitSdk(sdkManifest);
        const writes: Promise<unknown>[] = [];
        for (const [name, contents] of files) {
          writes.push(uploadToProject(buildId, `lib/sdk/${name}`, contents));
        }
        await Promise.all(writes);
      }),
    );

    await Promise.all(uploads);

    // Wave 2: component downloads + shell LLMs (parallel)
    const componentDownloads = await step.run(
      "download-components",
      async (): Promise<{ downloaded: number; missing: string[] }> => {
        const supabase = createAdminClient();
        const ok = inventoryRows.filter(
          (r) => r.compile_status === "ok" && r.tier !== "passthrough" && r.block_name !== "__null__",
        );
        const missing: string[] = [];
        let downloaded = 0;
        const batches: typeof ok[] = [];
        for (let i = 0; i < ok.length; i += 8) batches.push(ok.slice(i, i + 8));
        for (const batch of batches) {
          await Promise.all(
            batch.map(async (row) => {
              const componentName = blockNameToPascal(row.block_name);
              const srcPath = COMPONENT_PATH(buildId, `${componentName}.tsx`);
              const { data, error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).download(srcPath);
              if (error || !data) {
                missing.push(row.block_name);
                return;
              }
              const text = await data.text();
              await uploadToProject(buildId, `components/blocks/${componentName}.tsx`, rewriteBlockNodeImports(text));
              downloaded++;
            }),
          );
        }
        return { downloaded, missing };
      },
    );

    if (componentDownloads.missing.length > 0) {
      console.warn(
        `[compose-site] ${componentDownloads.missing.length} components missing — dispatcher routes them to Passthrough:`,
        componentDownloads.missing.slice(0, 10),
      );
    }

    const shellClient = modelClientForTier("visual");
    // Class-name inventory derived from the captured theme stylesheets.
    // Empty array when no stylesheets were captured — the shell prompt then
    // falls back to "Tailwind tokens only" mode (same as before this fix).
    const themeClassNames = extractThemeClassNames(themeStylesheets);
    const baseShellInput = {
      themeTokens,
      themeClassNames,
      menu: extractPrimaryMenu(project.manifest),
      logoUrl: project.logo_storage_path,
      siteName: project.name,
      siteDescription: description,
      client: shellClient,
    };

    await Promise.all([
      step.run("generate-header", async () => {
        const out = await generateShell({
          ...baseShellInput,
          kind: "header",
          shellDom: designTokens.shellDom?.header ?? "",
        });
        await persistShellGeneration({ buildId, projectId, shell: out });
        return out;
      }),
      step.run("generate-footer", async () => {
        const out = await generateShell({
          ...baseShellInput,
          kind: "footer",
          shellDom: designTokens.shellDom?.footer ?? "",
        });
        await persistShellGeneration({ buildId, projectId, shell: out });
        return out;
      }),
    ]);

    // Emit layout BEFORE the compile gate. layout.tsx imports Header/Footer
    // (just generated in Wave 2) and is a Next.js requirement; if the gate
    // runs without it, it's typechecking an incomplete tree that wouldn't
    // build on Vercel anyway. Order matters: layout → gate → mark-built.
    await step.run("emit-layout", () =>
      uploadToProject(buildId, "app/layout.tsx", emitLayoutTsx(project.name, description)),
    );

    // Compile gate: run tsc --noEmit on the materialized project tree before
    // transitioning to "building" and dispatching the Vercel deploy.
    // ON BY DEFAULT — set JAB_COMPOSE_TYPECHECK=0 to opt out for local dev.
    // Catches type errors, module-resolution failures, missing "use client"
    // directives, and prop-contract mismatches that Phase B's parse-only
    // validateTsx cannot detect.
    // On failure, compileGeneratedProject marks the build failed itself and
    // returns { success: false } — the worker returns early, no further writes.
    const compileResult = await step.run("compile-generated-project", async () =>
      compileGeneratedProject({ buildId, projectId }),
    );

    if (!compileResult.success) {
      // Build already marked failed by compileGeneratedProject.
      return { buildId, missingComponents: componentDownloads.missing.length, compileFailed: true };
    }

    await step.run("mark-built", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("site_builds")
        .update({ status: "building", finished_at: new Date().toISOString() })
        .eq("id", buildId)
        .eq("project_id", projectId);
      if (error) throw new Error(`mark-built failed: ${error.message}`);
    });

    await step.sendEvent("dispatch-deploy", {
      name: "site/deploy.requested",
      data: { projectId, tenantId, buildId },
    });

    return { buildId, missingComponents: componentDownloads.missing.length };
  },
);

async function uploadToProject(buildId: string, filePath: string, contents: string): Promise<void> {
  const supabase = createAdminClient();
  const path = PROJECT_PATH(buildId, filePath);
  const buf = Buffer.from(contents, "utf8");
  let lastError: { message: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .upload(path, buf, { contentType: "text/plain", upsert: true });
    if (!error) {
      lastError = null;
      break;
    }
    lastError = error;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * Math.pow(3, attempt)));
  }
  if (lastError) {
    throw new Error(`[compose-site] upload failed for ${filePath}: ${lastError.message}`);
  }
}

/**
 * blockNameToPascal — fourth copy of the toPascalCase logic in this repo.
 * DO NOT deduplicate now (per plan §17 note): matches persist-generation.ts
 * and compose-site-emit.ts toPascalCase exactly.
 */
function blockNameToPascal(s: string): string {
  const trimmed = s.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
  const pascal = trimmed
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c: string) => c.toUpperCase());
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}

function extractPrimaryMenu(manifest: unknown): import("@/lib/ai/shell-prompts").ShellMenu | null {
  if (!manifest || typeof manifest !== "object") return null;
  const m = manifest as { menus?: unknown };
  if (!Array.isArray(m.menus) || m.menus.length === 0) return null;
  const first = m.menus[0] as { name?: unknown; items?: unknown };
  if (typeof first.name !== "string" || !Array.isArray(first.items)) return null;
  const items = first.items
    .filter((i): i is { title: string; url: string } => {
      if (!i || typeof i !== "object") return false;
      const o = i as { title?: unknown; url?: unknown };
      return typeof o.title === "string" && typeof o.url === "string";
    })
    .slice(0, 30);
  return { name: first.name, items };
}
