import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import {
  emitDispatcherTsx,
  emitPassthroughTsx,
  emitThemeCss,
  type BlockInventoryRowForDispatch,
} from "@/lib/jab/compose-site-emit";
import { bundleDraftRuntime, draftComponentName } from "./bundle";
import { buildDraftCss } from "./css";
import { resolveThemeTokens, type ThemeJsonTokens, type ScrapedBrandTokens } from "@/lib/jab/global-styles";
import type { ThemeStylesheetCapture } from "@/lib/jab/capture-theme-stylesheets";

/**
 * artifacts — ensures drafts/base/<buildId>/{bundle.js,draft.css} exist in
 * Storage for the read-only Phase 1 renderer. Built once per build, lazily
 * on first /draft request, then immutable (a build's components never
 * change after `ready`). Phase 2 supersedes this with per-version paths
 * written by the draft-edit worker at commit time.
 */
export function baseDraftArtifactPath(buildId: string, file: "bundle.js" | "draft.css"): string {
  return `drafts/base/${buildId}/${file}`;
}

interface InventoryRow {
  block_name: string | null;
  tier: string | null;
  compile_status: string | null;
}

export function dispatcherRowsFromInventory(rows: InventoryRow[]): BlockInventoryRowForDispatch[] {
  return rows.map((r) => ({ blockName: r.block_name, tier: r.tier, compileStatus: r.compile_status }));
}

export interface ArtifactDeps {
  artifactExists(path: string): Promise<boolean>;
  loadInventory(buildId: string): Promise<InventoryRow[]>;
  loadComponentSources(buildId: string, names: string[]): Promise<Record<string, string>>;
  loadShellSource(buildId: string, kind: "header" | "footer"): Promise<string | null>;
  loadProjectMeta(buildId: string): Promise<{ wpUrl: string; tokens: ThemeJsonTokens | null; themeCss: string | null }>;
  bundle: typeof bundleDraftRuntime;
  buildCss: typeof buildDraftCss;
  upload(path: string, contents: string, contentType: string): Promise<void>;
}

export async function ensureBaseDraftArtifacts(
  args: { buildId: string },
  deps: ArtifactDeps,
): Promise<{ bundlePath: string; cssPath: string }> {
  const bundlePath = baseDraftArtifactPath(args.buildId, "bundle.js");
  const cssPath = baseDraftArtifactPath(args.buildId, "draft.css");

  const [haveBundle, haveCss] = await Promise.all([
    deps.artifactExists(bundlePath),
    deps.artifactExists(cssPath),
  ]);
  if (haveBundle && haveCss) return { bundlePath, cssPath };

  const inventory = await deps.loadInventory(args.buildId);
  const dispatcherRows = dispatcherRowsFromInventory(inventory);
  const usableNames = dispatcherRows
    .filter((r) => r.blockName && r.blockName !== "core/image" && r.tier !== "passthrough" && r.compileStatus === "ok")
    .map((r) => draftComponentName(r.blockName as string));

  const [componentSources, headerSource, footerSource, meta] = await Promise.all([
    deps.loadComponentSources(args.buildId, usableNames),
    deps.loadShellSource(args.buildId, "header"),
    deps.loadShellSource(args.buildId, "footer"),
    deps.loadProjectMeta(args.buildId),
  ]);

  const dispatcherSource = emitDispatcherTsx(dispatcherRows);
  const passthroughSource = emitPassthroughTsx();

  const { js } = await deps.bundle({
    componentSources,
    dispatcherSource,
    passthroughSource,
    headerSource,
    footerSource,
    wpUrl: meta.wpUrl,
  });
  const css = await deps.buildCss({
    sources: [...Object.values(componentSources), headerSource ?? "", footerSource ?? ""],
    tokens: meta.tokens,
    themeCss: meta.themeCss,
  });

  // SITE_SCREENSHOTS_BUCKET allowedMimeTypes is ["image/png","image/jpeg","text/plain"];
  // use text/plain for both artifacts — the asset route sets the correct
  // Content-Type header when serving them.
  await deps.upload(bundlePath, js, "text/plain");
  await deps.upload(cssPath, css, "text/plain");
  return { bundlePath, cssPath };
}

/* ---------------- production deps ---------------- */

export function defaultArtifactDeps(projectId: string): ArtifactDeps {
  const admin = createAdminClient();
  const storage = () => admin.storage.from(SITE_SCREENSHOTS_BUCKET);

  return {
    async artifactExists(path) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      const name = path.slice(path.lastIndexOf("/") + 1);
      const { data } = await storage().list(dir);
      return (data ?? []).some((f) => f.name === name);
    },
    async loadInventory(buildId) {
      const { data, error } = await admin
        .from("block_inventory")
        .select("block_name, tier, compile_status")
        .eq("site_build_id", buildId);
      if (error) throw new Error(`draft loadInventory failed: ${error.message}`);
      return (data ?? []) as InventoryRow[];
    },
    async loadComponentSources(buildId, names) {
      const out: Record<string, string> = {};
      await Promise.all(
        names.map(async (name) => {
          const { data } = await storage().download(`builds/${buildId}/components/${name}.tsx`);
          if (data) out[name] = await data.text();
        }),
      );
      return out;
    },
    async loadShellSource(buildId, kind) {
      const file = kind === "header" ? "Header.tsx" : "Footer.tsx";
      const { data } = await storage().download(`builds/${buildId}/project/components/site/${file}`);
      return data ? await data.text() : null;
    },
    async loadProjectMeta() {
      const { data, error } = await admin
        .from("projects")
        .select("wp_url, design_tokens")
        .eq("id", projectId)
        .single();
      if (error || !data) throw new Error(`draft loadProjectMeta failed: ${error?.message ?? "no row"}`);
      // design_tokens layout mirrors compose-site.ts (lines 219-246):
      //   { themeJson?: ThemeJsonTokens; themeStylesheets?: ThemeStylesheetCapture[]; scraped?: ... }
      const dt = (data.design_tokens ?? {}) as {
        themeJson?: ThemeJsonTokens | null;
        themeStylesheets?: ThemeStylesheetCapture[] | null;
        colors?: ScrapedBrandTokens["colors"];
        typography?: ScrapedBrandTokens["typography"];
      };
      const sheets = dt.themeStylesheets ?? [];
      return {
        wpUrl: data.wp_url as string,
        // Mirror compose-site.ts: prefer themeJson, fall back to scraped
        // brand tokens for classic-theme sites (e.g. Two Roads).
        tokens: resolveThemeTokens(dt.themeJson, { colors: dt.colors, typography: dt.typography }),
        themeCss: sheets.length > 0 ? emitThemeCss(sheets) : null,
      };
    },
    bundle: bundleDraftRuntime,
    buildCss: buildDraftCss,
    upload: async (path, contents, contentType) => {
      const { error } = await storage().upload(path, Buffer.from(contents, "utf-8"), {
        contentType,
        upsert: true,
      });
      if (error) throw new Error(`draft artifact upload failed (${path}): ${error.message}`);
    },
  };
}
