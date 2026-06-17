import "server-only";
import { composeBlockTree, type RenderableBlock } from "@/lib/jab/compose-block-tree-runtime";
import { resolveRelationshipRefs, type CallAbility, type MediaResolver } from "@/lib/jab/related-posts-runtime";
import { resolveDynamicLists, type DynamicListSpec } from "@/lib/jab/dynamic-lists-runtime";
import { resolveDraftRoute, type DraftPageRow } from "./route-resolve";
import type { ManifestShape } from "@/lib/jab/ability-meta";
import {
  createJabMcpClient,
  loadJabCredentials,
  type JabCredentials,
} from "@/lib/jab/ability-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { dynamicListSpecsFromInventory } from "@/lib/jab/dynamic-list-detect";

/**
 * page-data — the draft renderer's server half. Runs the IDENTICAL pure
 * pipeline the emitted pages run at request time (see emitCatchAllPageTsx):
 * by-slug ability → response[wrapperKey] → composeBlockTree → relationship +
 * dynamic-list hydration. NO LLM code executes here — this is data assembly
 * only (spec §7.4).
 */
export type DraftPageDataResult =
  | { kind: "page"; path: string; blocks: RenderableBlock[] }
  | { kind: "redirect"; to: "/" }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export interface DraftPageDeps {
  loadPages(buildId: string): Promise<DraftPageRow[]>;
  loadManifest(buildId: string): Promise<ManifestShape>;
  loadFrontPageSlug(buildId: string): Promise<string | null>;
  loadAcfFlexFields(buildId: string): Promise<Record<string, string[]>>;
  loadDynamicListSpecs(buildId: string): Promise<Record<string, DynamicListSpec>>;
  callAbility: CallAbility;
  resolveMedia?: MediaResolver;
}

export async function loadDraftPageData(
  args: { buildId: string; path: string },
  deps: DraftPageDeps,
): Promise<DraftPageDataResult> {
  try {
    const [pages, manifest, frontPageSlug] = await Promise.all([
      deps.loadPages(args.buildId),
      deps.loadManifest(args.buildId),
      deps.loadFrontPageSlug(args.buildId),
    ]);
    const resolution = resolveDraftRoute(args.path, pages, manifest, frontPageSlug);
    if (resolution.kind !== "page") return resolution;

    const t = resolution.target;
    const response = (await deps.callAbility(t.abilityName, {
      slug: t.slug,
      include: { blocks: true },
    })) as Record<string, unknown> | null;
    const record = response?.[t.wrapperKey];
    if (!record || typeof record !== "object") return { kind: "not_found" };

    const [acfFlexFields, dynamicSpecs] = await Promise.all([
      deps.loadAcfFlexFields(args.buildId),
      deps.loadDynamicListSpecs(args.buildId),
    ]);
    const blocks = composeBlockTree(
      record as Parameters<typeof composeBlockTree>[0],
      t.postType,
      t.paradigms,
      { acfFlexFields },
    );
    await resolveRelationshipRefs(blocks as never, deps.callAbility, deps.resolveMedia);
    await resolveDynamicLists(blocks as never, deps.callAbility, dynamicSpecs, deps.resolveMedia);
    return { kind: "page", path: args.path, blocks };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/* ---------------- production deps wiring ---------------- */

/** CallAbility over @jab/core McpClient — same error discipline as callJab. */
export function createCallAbility(client: ReturnType<typeof createJabMcpClient>): CallAbility {
  return async (abilityName, input) => {
    const result = await client.callTool<unknown>(abilityName, input ?? {});
    if ((result as { isError?: boolean }).isError) {
      throw new Error(`${abilityName} returned isError`);
    }
    return (result as { structuredContent?: unknown }).structuredContent;
  };
}

/** Media resolver bound to explicit creds (the env-based one is for emitted sites). */
export function mediaResolverFromCreds(creds: JabCredentials): MediaResolver {
  const auth = "Basic " + Buffer.from(`${creds.username}:${creds.appPassword}`).toString("base64");
  const cache = new Map<number, { url: string; alt?: string } | null>();
  return async (attachmentId) => {
    if (cache.has(attachmentId)) return cache.get(attachmentId) ?? null;
    try {
      const res = await fetch(`${creds.wpUrl}/wp-json/wp/v2/media/${attachmentId}`, {
        headers: { Authorization: auth },
      });
      if (!res.ok) {
        cache.set(attachmentId, null);
        return null;
      }
      const j = (await res.json()) as { source_url?: string; alt_text?: string };
      const ref = j.source_url ? { url: j.source_url, alt: j.alt_text ?? "" } : null;
      cache.set(attachmentId, ref);
      return ref;
    } catch {
      cache.set(attachmentId, null);
      return null;
    }
  };
}

export async function defaultDraftPageDeps(
  projectId: string,
  tenantId: string,
): Promise<DraftPageDeps> {
  const admin = createAdminClient();
  const creds = await loadJabCredentials(projectId, tenantId);
  const client = createJabMcpClient(creds);

  return {
    async loadPages(buildId) {
      const { data, error } = await admin
        .from("page_inventory")
        .select("slug, post_type, route_path, paradigms")
        .eq("site_build_id", buildId);
      if (error) throw new Error(`draft loadPages failed: ${error.message}`);
      return (data ?? []) as DraftPageRow[];
    },
    async loadManifest() {
      const { data, error } = await admin
        .from("projects")
        .select("manifest")
        .eq("id", projectId)
        .single();
      if (error) throw new Error(`draft loadManifest failed: ${error.message}`);
      return ((data?.manifest ?? {}) as ManifestShape);
    },
    async loadFrontPageSlug(buildId) {
      const { data } = await admin
        .from("site_builds")
        .select("config")
        .eq("id", buildId)
        .single();
      const cfg = (data?.config ?? {}) as { front_page_slug?: unknown };
      return typeof cfg.front_page_slug === "string" && cfg.front_page_slug ? cfg.front_page_slug : null;
    },
    async loadAcfFlexFields(buildId) {
      const { data, error } = await admin
        .from("block_inventory")
        .select("block_name")
        .eq("site_build_id", buildId)
        .like("block_name", "acf_flex/%");
      if (error) throw new Error(`draft loadAcfFlexFields failed: ${error.message}`);
      const out: Record<string, Set<string>> = {};
      for (const row of data ?? []) {
        const parts = String((row as { block_name: string }).block_name).split("/");
        if (parts.length >= 4) {
          (out[parts[1]] ??= new Set()).add(parts[2]);
        }
      }
      return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
    },
    async loadDynamicListSpecs(buildId) {
      const [inventoryResult, manifestResult] = await Promise.all([
        admin
          .from("block_inventory")
          .select("block_name, kind, spec")
          .eq("site_build_id", buildId),
        admin.from("projects").select("manifest").eq("id", projectId).single(),
      ]);
      if (inventoryResult.error) throw new Error(`draft loadDynamicListSpecs failed: ${inventoryResult.error.message}`);
      const manifest = (manifestResult.data?.manifest ?? {}) as ManifestShape;
      const specs = dynamicListSpecsFromInventory((inventoryResult.data ?? []) as never, manifest as never);
      return Object.fromEntries(specs.map((s) => [s.blockName, s]));
    },
    callAbility: createCallAbility(client),
    resolveMedia: mediaResolverFromCreds(creds),
  };
}
