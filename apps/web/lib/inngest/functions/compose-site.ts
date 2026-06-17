import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET, PROJECT_ASSETS_BUCKET } from "@/lib/storage/bucket";
import { emitSdk } from "@jab/core";
import { markBuildFailed } from "@/lib/inngest/shared-failure";
import { modelClientForTier } from "@/lib/ai/model-client";
import {
  generateShell,
  buildShellBatchItem,
  finalizeShellBatchResult,
  mergeShellUsage,
  type GenerateShellOptions,
} from "@/lib/ai/generate-shell";
import type { GeneratedShell } from "@/lib/ai/generate-shell";
import {
  isBatchGenerateEnabled,
  pollVerdict,
  MAX_BATCH_POLLS,
  BATCH_POLL_INTERVAL,
} from "@/lib/jab/component-batch";
import {
  submitGenerationBatch,
  getBatchStatus,
  collectBatchResults,
  cancelGenerationBatch,
  type BatchRequestItem,
  type BatchResultItem,
} from "@/lib/ai/batch-client";
import { persistShellGeneration, shouldReuseShell, shellArtifactExists } from "@/lib/ai/persist-shell-generation";
import { extractThemeClassNames } from "@/lib/ai/shell-prompts";
import { CLASSIC_BLOCK_NAME, CLASSIC_COMPONENT_NAME } from "@/lib/jab/classic-content";
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
  buildGoogleFontLinks,
  emitRobotsTs,
  emitSitemapTs,
  emitAcfFlexFieldsTs,
  emitPassthroughTsx,
  emitDispatcherTsx,
  emitHomepageTsx,
  emitBlogIndexTsx,
  emitCatchAllPageTsx,
  emitRouteMapTs,
  emitPostTypeMapTs,
  postTypeMapEntriesFromPages,
  emitReadmeMd,
  emitMediaImageTsx,
  MEDIA_IMAGE_FILE_PATH,
  harvestImageHosts,
  emitRelatedPostsTs,
  emitDynamicListsTs,
  emitDynamicListsMapTs,
  alignSpecPostTypesToRoutes,
  emitRewriteLinksTs,
  type ThemeStylesheetCapture,
} from "@/lib/jab/compose-site-emit";
import { dynamicListSpecsFromInventory } from "@/lib/jab/dynamic-list-detect";
import type { Manifest } from "@jab/core";
import type { ThemeJsonTokens, ScrapedBrandTokens } from "@/lib/jab/global-styles";
import { resolveThemeTokens } from "@/lib/jab/global-styles";
import { rewriteBlockNodeImports } from "@/lib/jab/import-rewrite";
import { hostVariants, buildRoutePathMap } from "@/lib/jab/rewrite-origin-links";
import { compileGeneratedProject } from "@/lib/jab/compile-generated-project";
import { isBuildCancelled } from "@/lib/jab/build-cancel";
import { isEditConfig, type BuildConfig } from "@/lib/jab/build-config";
import { abilityMetaFor, type ManifestShape } from "@/lib/jab/ability-meta";
import { resolveHomepageEmit } from "@/lib/jab/homepage-emit";
import { ACTIVE_BUILD_PHASES } from "@/lib/jab/build-status";
import { isUniqueViolation } from "@/lib/db/pg-error";

/**
 * compose-site — Phase C Inngest worker.
 *
 * Triggered by site/compose.requested (dispatched by generateComponents on
 * clean exit). Status machine: 'composing' on entry → 'built' on clean exit
 * → dispatches site/deploy.requested.
 *
 * Three-wave step.run sequencing (spec §5):
 *   Wave 1 (parallel): all deterministic emissions.
 *   Wave 2: component downloads + bundle-logo, then shell LLMs sequential
 *           (generate-header → persist-header → generate-footer →
 *           persist-footer) for Anthropic prompt-cache read-after-write.
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
  link: string | null;
}

interface BlockInventoryRowForCompose {
  block_name: string;
  tier: string | null;
  compile_status: string | null;
  kind: string | null;
  spec: unknown;
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

export const composeSite = inngest.createFunction(
  { id: "compose-site", retries: 0 },
  { event: "site/compose.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, buildId } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
    };

    try {
      const cancelledAtEntry = await step.run("compose-cancel-guard", async () => {
        const supabase = createAdminClient();
        return isBuildCancelled(supabase, buildId, projectId);
      });
      if (cancelledAtEntry) {
        console.log(`[compose-site] build ${buildId} is cancelled — skipping compose.`);
        return { buildId, cancelled: true };
      }

    // Terminal-state guard: only advance from an ACTIVE prior status. A
    // discard (cancelled) or stale auto-fail (failed) that landed since the
    // entry guard must not be overwritten back to an active status. Zero
    // rows updated = terminal elsewhere — stop. This is also an edit build's
    // queued→active boundary against the 0031 one-active-build index, hence
    // the friendly 23505 message.
    // Zero-rows→terminal is sound only because createAdminClient bypasses RLS; a user-scoped client could update a row its SELECT can't see and falsely read terminal.
    const composingAdvanced = await step.run("mark-composing-phase", async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("site_builds")
        .update({ status: "composing" })
        .eq("id", buildId)
        .eq("project_id", projectId)
        .in("status", [...ACTIVE_BUILD_PHASES])
        .select("id");
      if (error) {
        if (isUniqueViolation(error)) {
          throw new Error(
            "another build was already active for this project — this build lost the start race and was marked failed",
          );
        }
        throw new Error(`mark-composing-phase failed: ${error.message}`);
      }
      return (data ?? []).length > 0;
    });
    if (!composingAdvanced) {
      console.log(`[compose-site] build ${buildId} reached a terminal state elsewhere (discard or auto-fail) — stopping.`);
      return { buildId, cancelled: true };
    }

    // Load inputs in parallel
    const [inventoryRows, pageRows, project, buildConfig] = await Promise.all([
      step.run("load-inventory", async (): Promise<BlockInventoryRowForCompose[]> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("block_inventory")
          .select("block_name, tier, compile_status, kind, spec")
          .eq("site_build_id", buildId)
          .eq("project_id", projectId);
        if (error) throw new Error(`load-inventory failed: ${error.message}`);
        return (data ?? []) as BlockInventoryRowForCompose[];
      }),
      step.run("load-pages", async (): Promise<PageInventoryRow[]> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("page_inventory")
          .select("slug, post_type, route_path, paradigms, link")
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
      step.run("load-build-config", async (): Promise<BuildConfig> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("site_builds")
          .select("config")
          .eq("id", buildId)
          .single();
        if (error || !data) throw new Error(`load-build-config failed: ${error?.message ?? "no row"}`);
        return (data.config ?? { mode: "full" }) as BuildConfig;
      }),
    ]);

    const designTokens = (project.design_tokens ?? {}) as {
      themeJson?: ThemeJsonTokens;
      themeStylesheets?: ThemeStylesheetCapture[];
      shellDom?: { header: string | null; footer: string | null };
      // Computed (rendered) chrome colors captured in discovery — lets the
      // shell LLM paint the header/footer roots with the real brand color
      // even when its CSS class isn't in the captured stylesheet.
      shellStyles?: {
        header: { backgroundColor?: string; color?: string } | null;
        footer: { backgroundColor?: string; color?: string } | null;
      };
      personality?: { description?: string | null };
      // Scrape-agent output — sibling shape to themeJson, populated for
      // classic-theme sites where wp/v2/global-styles is empty.
      colors?: ScrapedBrandTokens["colors"];
      typography?: ScrapedBrandTokens["typography"];
    };
    // Resolve themeTokens via the composite adapter: prefer wp/v2/global-styles
    // when present (FSE / block themes), fall back to the AI scrape-agent's
    // brand inference for classic themes. Without this, Two Roads built with
    // `themeTokens = null` → empty tailwind tokens + LLM saw "Colors: (none)"
    // → masthead emitted bg-white instead of the captured brand yellow.
    // See docs/superpowers/specs/2026-05-29-two-roads-diagnosis.md.
    const themeTokens = resolveThemeTokens(designTokens.themeJson, {
      colors: designTokens.colors,
      typography: designTokens.typography,
    });
    const themeStylesheets = designTokens.themeStylesheets ?? [];
    const hasThemeCss = themeStylesheets.length > 0;
    const description = designTokens.personality?.description ?? null;
    const wpUrl = project.wp_url;

    // Loud-error validation: every downstream emitter that touches the WP
    // origin (next.config.ts remotePatterns, robots.ts, sitemap.ts) needs a
    // valid URL. Pre-2026-05-29 emitNextConfigTs silently fell back to a
    // hostname of "**", which Next.js rejects — every <Image> rendered
    // blank in the deployed Two Roads pilot. Validate once here so the
    // failure surfaces as failed_phase='composing' with a clear error_text
    // BEFORE any partial Storage writes happen.
    if (typeof wpUrl !== "string" || wpUrl.trim().length === 0) {
      throw new Error(
        `compose-site: project ${projectId} has no wp_url. Cannot emit next.config.ts (or robots/sitemap). Set projects.wp_url before re-running the build.`,
      );
    }
    try {
      new URL(wpUrl);
    } catch {
      throw new Error(
        `compose-site: project ${projectId} has wp_url=${JSON.stringify(wpUrl)} which is not a valid URL. Expected scheme + host (e.g. "https://example.com").`,
      );
    }

    const manifest = (project.manifest ?? {}) as ManifestShape;

    // Homepage emit decision: show_on_front='posts' → blog index; otherwise
    // the static-page path (reproduced verbatim inside resolveHomepageEmit,
    // including the legacy route_path='/' fallback + the two loud errors).
    const homepage = resolveHomepageEmit(
      buildConfig,
      pageRows.map((p) => ({ slug: p.slug, post_type: p.post_type, route_path: p.route_path, paradigms: p.paradigms })),
      manifest,
    );
    const frontPageSlug = homepage.kind === "static" ? homepage.frontPageSlug : null;

    // Wave 1: parallel deterministic emissions
    const uploads: Array<Promise<unknown>> = [];

    uploads.push(step.run("emit-tsconfig", () => uploadToProject(buildId, "tsconfig.json", emitTsconfigJson())));
    uploads.push(step.run("emit-gitignore", () => uploadToProject(buildId, ".gitignore", emitGitignore())));
    uploads.push(step.run("emit-postcss", () => uploadToProject(buildId, "postcss.config.mjs", emitPostcssConfig())));
    uploads.push(step.run("emit-not-found", () => uploadToProject(buildId, "app/not-found.tsx", emitNotFoundTsx())));
    // Harvest CDN image hosts from captured shellDom + theme CSS so the
    // emitted next.config.ts whitelists them alongside the primary wp_url.
    // Without this, ShortPixel-rewritten images (Two Roads footer logo at
    // sp-ao.shortpixel.ai), Jetpack Photon images at i*.wp.com, and other
    // optimizer-rewritten URLs fail at runtime via next/image. The
    // harvester is conservative: it walks shellDom HTML + theme stylesheets
    // looking for image-extension URLs, filters out the primary host, and
    // returns a stable-sorted unique-hostname set.
    const primaryHost = new URL(project.wp_url).hostname;
    const imageHostSources: Array<string | null | undefined> = [
      designTokens.shellDom?.header ?? null,
      designTokens.shellDom?.footer ?? null,
      ...themeStylesheets.map((s) => s.css),
    ];
    const extraImageHosts = harvestImageHosts(imageHostSources, primaryHost);
    uploads.push(step.run("emit-next-config", () => uploadToProject(buildId, "next.config.ts", emitNextConfigTs(project.wp_url, extraImageHosts))));
    uploads.push(step.run("emit-env-example", () => uploadToProject(buildId, ".env.example", emitEnvExample())));
    uploads.push(step.run("emit-package-json", () => uploadToProject(buildId, "package.json", emitPackageJson(project.name))));
    uploads.push(step.run("emit-readme", () => uploadToProject(buildId, "README.md", emitReadmeMd(project.name))));
    uploads.push(step.run("emit-tailwind", () => uploadToProject(buildId, "tailwind.config.ts", emitTailwindConfigTs(themeTokens))));
    // Brand fonts (slugs "heading"/"body" from the scrape-agent token path) are
    // forced onto semantic elements via globals.css — generated components use
    // generic Tailwind classes and otherwise fall back to the system font stack.
    const brandFonts = {
      heading: themeTokens?.fontFamilies?.find((f) => f.slug === "heading")?.fontFamily ?? null,
      body: themeTokens?.fontFamilies?.find((f) => f.slug === "body")?.fontFamily ?? null,
    };
    uploads.push(step.run("emit-globals-css", () => uploadToProject(buildId, "app/globals.css", emitGlobalsCss(hasThemeCss, brandFonts))));
    if (hasThemeCss) {
      uploads.push(step.run("emit-theme-css", () => uploadToProject(buildId, "styles/theme.css", emitThemeCss(themeStylesheets))));
    }
    uploads.push(step.run("emit-robots", () => uploadToProject(buildId, "app/robots.ts", emitRobotsTs(wpUrl))));
    uploads.push(
      step.run("emit-sitemap", () =>
        uploadToProject(
          buildId,
          "app/sitemap.ts",
          emitSitemapTs(
            [
              ...pageRows.map((p) => ({ routePath: p.route_path })),
              ...homepage.sitemapExtraRoutes.map((routePath) => ({ routePath })),
            ],
            wpUrl,
          ),
        ),
      ),
    );
    uploads.push(step.run("emit-passthrough", () => uploadToProject(buildId, "components/blocks/_passthrough.tsx", emitPassthroughTsx())));
    // Emit the MediaImage platform shim — the dispatcher routes core/image
    // here unconditionally (see emitDispatcherTsx) so the runtime safety
    // net for unknown image hosts (next/image rejects them at request
    // time) is the load-bearing path, not an aspirational unused module.
    uploads.push(step.run("emit-media-image", () => uploadToProject(buildId, MEDIA_IMAGE_FILE_PATH, emitMediaImageTsx())));
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

    // Fallback registry behind ROUTE_MAP: one entry per discovered post type
    // (incl. "page"). The emitted catch-all resolves un-enumerated detail URLs
    // through this at request time.
    uploads.push(
      step.run("emit-post-type-map", () => {
        const { entries, omitted } = postTypeMapEntriesFromPages(
          pageRows.map((p) => ({ post_type: p.post_type, paradigms: p.paradigms })),
          (postType) => abilityMetaFor(postType, manifest),
        );
        if (omitted.length > 0) {
          console.warn(
            `[compose-site] no by-slug ability for post_type(s) ${omitted.join(", ")} — they won't resolve via the catch-all fallback`,
          );
        }
        return uploadToProject(buildId, "app/[...slug]/post-type-map.ts", emitPostTypeMapTs(entries, frontPageSlug ?? null));
      }),
    );

    // Homepage emit: blog index for show_on_front='posts' sites, otherwise the
    // static by-slug page. Both reproduce their respective behavior verbatim
    // (the static branch matches the prior emitHomepageTsx call exactly).
    uploads.push(
      step.run("emit-homepage", () =>
        uploadToProject(
          buildId,
          "app/page.tsx",
          homepage.kind === "blogIndex"
            ? emitBlogIndexTsx({
                listAbility: homepage.listAbility,
                wrapperKey: homepage.wrapperKey,
                postType: homepage.postType,
                limit: 12,
                heading: "Latest Posts",
              })
            : emitHomepageTsx({
                slug: homepage.frontPageSlug,
                abilityName: homepage.ability.abilityName,
                wrapperKey: homepage.ability.wrapperKey,
                paradigms: homepage.paradigms,
                postType: homepage.postType,
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
    uploads.push(
      step.run("emit-related-posts", () =>
        uploadToProject(buildId, "lib/jab/related-posts.ts", emitRelatedPostsTs()),
      ),
    );
    uploads.push(
      step.run("emit-dynamic-lists-runtime", () =>
        uploadToProject(buildId, "lib/jab/dynamic-lists.ts", emitDynamicListsTs()),
      ),
    );
    uploads.push(
      step.run("emit-rewrite-links", () =>
        uploadToProject(buildId, "lib/jab/rewrite-links.ts", emitRewriteLinksTs()),
      ),
    );
    uploads.push(
      step.run("emit-dynamic-lists-map", () =>
        uploadToProject(
          buildId,
          "lib/jab/dynamic-lists-map.ts",
          emitDynamicListsMapTs(
            alignSpecPostTypesToRoutes(
              dynamicListSpecsFromInventory(
                inventoryRows.map((r) => ({ block_name: r.block_name, kind: r.kind, spec: r.spec })),
                project.manifest as unknown as Manifest,
              ),
              pageRows.map((p) => p.post_type),
            ),
          ),
        ),
      ),
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

    // Bundle the captured logo into the generated project's /public so the
    // header renders it from a LOCAL static asset (`/logo.<ext>`). Previously
    // logoUrl was the project-assets Storage PATH (`projects/<id>/logo.png`),
    // which the header LLM emitted verbatim as the <Image> src →
    // `/_next/image?url=/projects/<id>/logo.png` → 404 on the deployed site.
    // Bundling fixes that AND sidesteps a next/image remote-host requirement
    // (local /public assets need no remotePatterns entry). Fail-soft: any
    // download/upload error leaves logoUrl null and the shell falls back to
    // the site name.
    const bundledLogoUrl = await step.run("bundle-logo", async (): Promise<string | null> => {
      const logoPath = project.logo_storage_path;
      if (!logoPath) return null;
      const admin = createAdminClient();
      const dl = await admin.storage.from(PROJECT_ASSETS_BUCKET).download(logoPath);
      if (dl.error || !dl.data) {
        console.warn(
          `[compose-site ${buildId}] logo download failed (${logoPath}): ${dl.error?.message ?? "no data"}`,
        );
        return null;
      }
      const ext = (logoPath.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
      const fileName = `logo.${ext}`;
      const contentType =
        ext === "svg" ? "image/svg+xml"
        : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "webp" ? "image/webp"
        : ext === "gif" ? "image/gif"
        : "image/png";
      const bytes = Buffer.from(await dl.data.arrayBuffer());
      const { error: upErr } = await admin.storage
        .from(SITE_SCREENSHOTS_BUCKET)
        .upload(PROJECT_PATH(buildId, `public/${fileName}`), bytes, { contentType, upsert: true });
      if (upErr) {
        console.warn(`[compose-site ${buildId}] logo bundle upload failed: ${upErr.message}`);
        return null;
      }
      return `/${fileName}`;
    });

    const shellClient = modelClientForTier("visual");
    // Class-name inventory derived from the captured theme stylesheets.
    // Empty array when no stylesheets were captured — the shell prompt then
    // falls back to "Tailwind tokens only" mode (same as before this fix).
    const themeClassNames = extractThemeClassNames(themeStylesheets);
    const baseShellInput = {
      themeTokens,
      themeClassNames,
      menu: extractPrimaryMenu(project.manifest),
      logoUrl: bundledLogoUrl,
      siteName: project.name,
      siteDescription: description,
      client: shellClient,
      // Deterministic BUG-A guarantee: strip the WP origin from every
      // generated shell href so nav stays on the clone.
      sourceHosts: hostVariants(wpUrl),
      // Exact permalink→route mapping (migration 0033). Empty for pre-0033
      // builds — the rewriter then falls back to plain origin-stripping.
      routePathMap: buildRoutePathMap(
        pageRows.map((p) => ({ link: p.link ?? null, route_path: p.route_path })),
      ),
      // Prompt-level defense-in-depth: tell the LLM that this host's URLs are
      // internal so it emits root-relative paths rather than absolute hrefs.
      // The deterministic rewriter (rewriteWpOriginUrls) is the hard guarantee;
      // this reduces how often the rewriter has work to do.
      sourceHost: new URL(wpUrl).hostname,
    };

    // Shell-scope edits thread their guidance through compose (regenerateShellUnit
    // is a no-op — the shell LLM only re-runs here). undefined for every non-shell
    // build so output is byte-identical to a full build.
    const shellEditGuidance = (kind: "header" | "footer"): string | undefined =>
      isEditConfig(buildConfig) && buildConfig.scope === "shell" && buildConfig.target === kind
        ? buildConfig.regeneration_prompt
        : undefined;

    // Iteration affordance: skip the (unchanged) shell LLM call when re-composing
    // a build that already has Header.tsx / Footer.tsx in Storage. For FULL builds
    // this is gated behind JAB_SKIP_SHELL_REGEN (off by default — production
    // regenerates). EDIT builds reuse their CLONED shells by default; a shell-scope
    // edit still regenerates its own target (guidance wins). See shouldReuseShell.
    const skipShellRegen =
      process.env.JAB_SKIP_SHELL_REGEN === "1" || process.env.JAB_SKIP_SHELL_REGEN === "true";
    // Edit builds reuse their cloned shells by default — see shouldReuseShell.
    const isEditBuild = isEditConfig(buildConfig);

    const shellOptsFor = (kind: "header" | "footer"): GenerateShellOptions => ({
      ...baseShellInput,
      kind,
      shellDom:
        (kind === "header" ? designTokens.shellDom?.header : designTokens.shellDom?.footer) ?? "",
      shellColors:
        (kind === "header" ? designTokens.shellStyles?.header : designTokens.shellStyles?.footer) ??
        null,
      guidance: shellEditGuidance(kind),
    });

    // Shells-ride-along: batch the header+footer LLM calls on FULL builds
    // when JAB_BATCH_GENERATE=1. Edit builds always keep the sequential sync
    // path — a user is waiting on the edit→preview loop.
    const shellBatchEnabled = isBatchGenerateEnabled(process.env) && !isEditConfig(buildConfig);

    if (!shellBatchEnabled) {
      // ─── SYNC SHELL PATH — UNCHANGED (post-Phase-2 sequential steps) ───
      // Sequential, split steps (Phase 2):
      //  - header BEFORE footer: their stable prompt prefixes are byte-identical,
      //    and a cache entry is only readable after the first response begins
      //    streaming — sequencing turns the footer's prefix into a guaranteed
      //    cache read whenever the prefix qualifies (shouldCacheShellPrefix).
      //  - generate and persist in SEPARATE steps: with retries:0 a transient
      //    Storage/DB failure after a successful generation must not discard the
      //    paid tokens inside the same step; splitting makes the generation
      //    memoizable independently and the failure attributable.
      // Reuse path returns null (no persist needed — the artifact already exists).
      const headerOut = await step.run("generate-header", async (): Promise<GeneratedShell | null> => {
        const headerGuidance = shellEditGuidance("header");
        // Probe Storage ONLY when reuse can actually fire: guidance forces a
        // regen regardless, and with both triggers off the probe's value can't
        // matter — reuse is impossible either way, so false is a safe stand-in
        // and we skip the download round-trip on every normal full build.
        const reuseCouldFire = (skipShellRegen || isEditBuild) && headerGuidance === undefined;
        const artifactExists = reuseCouldFire ? await shellArtifactExists(buildId, "header") : false;
        if (
          shouldReuseShell({
            skipEnabled: skipShellRegen,
            isEditBuild,
            hasEditGuidance: headerGuidance !== undefined,
            artifactExists,
          })
        ) {
          console.log(
            `[compose-site ${buildId}] ${isEditBuild ? "edit build (no shell guidance for header)" : "JAB_SKIP_SHELL_REGEN"}: reusing existing Header.tsx`,
          );
          return null;
        }
        return generateShell({
          ...baseShellInput,
          kind: "header",
          shellDom: designTokens.shellDom?.header ?? "",
          shellColors: designTokens.shellStyles?.header ?? null,
          guidance: headerGuidance,
        });
      });
      if (headerOut) {
        await step.run("persist-header", () =>
          persistShellGeneration({ buildId, projectId, shell: headerOut }),
        );
      }

      const footerOut = await step.run("generate-footer", async (): Promise<GeneratedShell | null> => {
        const footerGuidance = shellEditGuidance("footer");
        // Same lazy-probe invariant as generate-header above.
        const reuseCouldFire = (skipShellRegen || isEditBuild) && footerGuidance === undefined;
        const artifactExists = reuseCouldFire ? await shellArtifactExists(buildId, "footer") : false;
        if (
          shouldReuseShell({
            skipEnabled: skipShellRegen,
            isEditBuild,
            hasEditGuidance: footerGuidance !== undefined,
            artifactExists,
          })
        ) {
          console.log(
            `[compose-site ${buildId}] ${isEditBuild ? "edit build (no shell guidance for footer)" : "JAB_SKIP_SHELL_REGEN"}: reusing existing Footer.tsx`,
          );
          return null;
        }
        return generateShell({
          ...baseShellInput,
          kind: "footer",
          shellDom: designTokens.shellDom?.footer ?? "",
          shellColors: designTokens.shellStyles?.footer ?? null,
          guidance: footerGuidance,
        });
      });
      if (footerOut) {
        await step.run("persist-footer", () =>
          persistShellGeneration({ buildId, projectId, shell: footerOut }),
        );
      }
    } else {
      // ─── SHELL BATCH PATH ───
      // Reuse carve-out first (JAB_SKIP_SHELL_REGEN): only non-reused kinds batch.
      const kindsToGenerate: Array<"header" | "footer"> = [];
      for (const kind of ["header", "footer"] as const) {
        // Lazy probe (same invariant as the sync path): the only reuse trigger
        // in this branch is JAB_SKIP_SHELL_REGEN — edit builds never reach it,
        // so with the flag off the probe can't matter and false is a safe
        // stand-in. The skip decision is env-derived and stable across replays.
        const artifactExists = skipShellRegen
          ? await step.run(`shell-batch-reuse-check-${kind}`, () =>
              shellArtifactExists(buildId, kind),
            )
          : false;
        if (
          shouldReuseShell({
            skipEnabled: skipShellRegen,
            isEditBuild, // always false here — edit builds never reach this branch
            hasEditGuidance: false, // edit builds never reach this branch
            artifactExists,
          })
        ) {
          console.log(`[compose-site ${buildId}] JAB_SKIP_SHELL_REGEN: reusing existing ${kind}`);
        } else {
          kindsToGenerate.push(kind);
        }
      }

      // Submit one batch for the kinds that have shellDom. Kinds with empty
      // shellDom skip the batch — sync generateShell's short-circuit emits
      // the deterministic fallback at zero tokens.
      const submitted = await step.run("shell-batch-submit", async () => {
        const entries: Array<{ kind: "header" | "footer"; item: BatchRequestItem }> = [];
        for (const kind of kindsToGenerate) {
          const item = buildShellBatchItem(shellOptsFor(kind), `shell_${kind}`);
          if (item) entries.push({ kind, item });
        }
        if (entries.length === 0) return null;
        const batchId = await submitGenerationBatch(entries.map((e) => e.item));
        console.log(`[compose-site ${buildId}] shell batch submitted: ${batchId}`);
        return { batchId, kinds: entries.map((e) => e.kind) };
      });

      for (const kind of kindsToGenerate) {
        if (!submitted || !submitted.kinds.includes(kind)) {
          await step.run(`shell-batch-empty-${kind}`, async () => {
            // Generate+persist combined in one step on purpose: empty shellDom
            // means generateShell returns the deterministic zero-token fallback,
            // so there are no paid tokens for the sync path's split-step rule to protect.
            const out = await generateShell(shellOptsFor(kind));
            await persistShellGeneration({ buildId, projectId, shell: out });
            return { shellKind: kind, compileStatus: out.compileStatus };
          });
        }
      }

      if (submitted) {
        // Durable poll loop: up to 61 polls (poll-0..poll-60) × 30s sleeps
        // ≈ 30.5 min worst case (pollVerdict times out at polls >= MAX_BATCH_POLLS).
        let polls = 0;
        let verdict: "collect" | "wait" | "timeout" = "wait";
        while (verdict === "wait") {
          const status = await step.run(`shell-batch-poll-${polls}`, () =>
            getBatchStatus(submitted.batchId),
          );
          verdict = pollVerdict(status, polls);
          if (verdict === "wait") {
            polls++;
            // 0-indexed to align with poll IDs: sleep-N follows poll-N.
            await step.sleep(`shell-batch-sleep-${polls - 1}`, BATCH_POLL_INTERVAL);
          }
        }
        let collectable = verdict === "collect";
        if (verdict === "timeout") {
          await step.run("shell-batch-cancel", () => cancelGenerationBatch(submitted.batchId));
          await step.sleep("shell-batch-drain-sleep", BATCH_POLL_INTERVAL);
          const drained = await step.run("shell-batch-drain-poll", () =>
            getBatchStatus(submitted.batchId),
          );
          collectable = drained === "ended";
        }

        // Finalize: persist valid batch shells; report fallbacks (small output).
        // Persists are per-kind fail-soft (T7 component-wave pattern): with
        // retries:0 a transient Storage/DB throw must not fail the build, so a
        // failed persist downgrades that kind to the sync fallback with
        // priorUsage = the batch result's usage (mergeShellUsage folds the
        // wasted spend into the regen).
        const shellFallbacks = await step.run("shell-batch-finalize", async () => {
          const results: BatchResultItem[] = collectable
            ? await collectBatchResults(submitted.batchId)
            : [];
          const byId = new Map(results.map((r) => [r.customId, r]));
          const fallbacks: Array<{
            kind: "header" | "footer";
            priorUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
          }> = [];
          for (const kind of submitted.kinds) {
            const result = byId.get(`shell_${kind}`);
            const shell = result ? finalizeShellBatchResult(shellOptsFor(kind), result) : null;
            if (shell && result) {
              try {
                await persistShellGeneration({ buildId, projectId, shell });
              } catch (err) {
                console.warn(
                  `[compose-site ${buildId}] shell batch persist failed for ${kind} — downgrading to sync fallback`,
                  err,
                );
                fallbacks.push({ kind, priorUsage: result.usage });
              }
            } else {
              fallbacks.push({
                kind,
                priorUsage: result?.ok
                  ? result.usage
                  : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
              });
            }
          }
          return fallbacks;
        });

        // Sync fallback — SEQUENTIAL, header first (Phase 2 cache-ordering rule).
        for (const fallback of shellFallbacks) {
          await step.run(`shell-batch-fallback-${fallback.kind}`, async () => {
            const out = await generateShell(shellOptsFor(fallback.kind));
            await persistShellGeneration({
              buildId,
              projectId,
              shell: mergeShellUsage(out, fallback.priorUsage, 1),
            });
            return { shellKind: fallback.kind, compileStatus: out.compileStatus };
          });
        }
      }
    }

    // Emit layout BEFORE the compile gate. layout.tsx imports Header/Footer
    // (just generated in Wave 2) and is a Next.js requirement; if the gate
    // runs without it, it's typechecking an incomplete tree that wouldn't
    // build on Vercel anyway. Order matters: layout → gate → mark-built.
    // Brand fonts hosted off-theme (Google Fonts) are dropped by Phase A
    // capture; re-inject them from the captured fontFamily tokens as <link>
    // tags. Empty for sites with only theme-hosted / system fonts → layout
    // is byte-identical to the pre-fix output.
    const fontLinkHrefs = buildGoogleFontLinks(themeTokens);
    await step.run("emit-layout", () =>
      uploadToProject(buildId, "app/layout.tsx", emitLayoutTsx(project.name, description, fontLinkHrefs)),
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

    // Terminal-state guard (see mark-composing-phase). MUST run before the
    // deploy dispatch below — a terminal build never dispatches deploy.
    const builtAdvanced = await step.run("mark-built", async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("site_builds")
        .update({ status: "building", finished_at: new Date().toISOString() })
        .eq("id", buildId)
        .eq("project_id", projectId)
        .in("status", [...ACTIVE_BUILD_PHASES])
        .select("id");
      if (error) throw new Error(`mark-built failed: ${error.message}`);
      return (data ?? []).length > 0;
    });
    if (!builtAdvanced) {
      console.log(`[compose-site] build ${buildId} reached a terminal state elsewhere (discard or auto-fail) — stopping.`);
      return { buildId, cancelled: true };
    }

    await step.sendEvent("dispatch-deploy", {
      name: "site/deploy.requested",
      data: { projectId, tenantId, buildId },
    });

    return { buildId, missingComponents: componentDownloads.missing.length };
    } catch (err) {
      // Mirror discover-site.ts: flip the build row to status='failed' with
      // a descriptive error_text on any uncaught throw. Without this,
      // validation/emit throws (e.g. wp_url missing, emitNextConfigTs URL
      // parse failure) left the row stuck at 'composing' forever — no
      // Phase D dispatch, no operator signal. compileGeneratedProject
      // already marks failed itself before returning, so this is
      // idempotent for that path; for any other throw (load-* errors,
      // validation throws, emit throws) this is the only DB signal the
      // operator gets.
      await markBuildFailed({ buildId, projectId, phase: "composing", error: err });
      throw err;
    }
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
  // Classic sentinel maps to the ClassicContent wrapper (shared constants — the
  // pascal ALGORITHM stays duplicated per repo convention, only the mapping is centralized).
  if (s === CLASSIC_BLOCK_NAME) return CLASSIC_COMPONENT_NAME;
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
