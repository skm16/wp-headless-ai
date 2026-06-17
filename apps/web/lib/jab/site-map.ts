import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { MAX_PAGE_SLUGS_PER_BLOCK } from "@/lib/jab/inventory";

/**
 * site-map — compact, planner-facing description of a SOURCE build (spec §3.3).
 * buildSiteMap does the DB read; reduceSiteMap is the pure, unit-tested core.
 * The planner's `target` MUST be one of `blockTypes[].blockName` (component
 * scope) or a shell kind that is present (shell scope).
 */

export function shellFileName(kind: "header" | "footer"): string {
  return kind === "header" ? "Header.tsx" : "Footer.tsx";
}

/**
 * Pure shell-presence decision. Shell presence MUST reflect the emitted
 * artifact (builds/<id>/project/components/site/<Kind>.tsx), not the
 * shell_generations cost-telemetry table — edit/skip-regen/clone builds leave
 * the file in Storage without writing a telemetry row (e.g. header-only shell
 * edits and skip-shell-regen reuse builds). When the Storage listing itself
 * fails we fail CLOSED to "present":
 * compose always emits both shells, so a transient blip must not make the
 * planner falsely refuse a real shell. The rare genuinely-missing file is then
 * caught loudly downstream by the draft-edit loader.
 */
export function decideShellPresence(
  kind: "header" | "footer",
  listing: { ok: true; names: string[] } | { ok: false },
): boolean {
  if (!listing.ok) return true;
  return listing.names.includes(shellFileName(kind));
}

async function listShellDir(
  sourceBuildId: string,
): Promise<{ ok: true; names: string[] } | { ok: false }> {
  try {
    const supabase = createAdminClient();
    const dir = `builds/${sourceBuildId}/project/components/site`;
    const { data, error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).list(dir);
    if (error) return { ok: false };
    return { ok: true, names: (data ?? []).map((f) => f.name) };
  } catch {
    return { ok: false };
  }
}

export interface SiteMapBlockType {
  blockName: string;
  label: string;
  tier: string | null;
  occurrenceCount: number;
  /**
   * Distinct pages the block renders on. NOTE: block_inventory.page_slugs is
   * CAPPED at MAX_PAGE_SLUGS_PER_BLOCK (=50) by the inventory builder
   * (inventory.ts:151), so this is a FLOOR, not an exact count, once it hits
   * the cap — `pageCountIsFloor` says which. edit-impact.ts:7-9 already warns
   * that page_slugs is not trustworthy as an exact changed-page count.
   */
  pageCount: number;
  /** True when pageCount === MAX_PAGE_SLUGS_PER_BLOCK (the real count may be higher). */
  pageCountIsFloor: boolean;
}

export interface SiteMap {
  blockTypes: SiteMapBlockType[];
  pageSlugs: string[];
  shell: { header: boolean; footer: boolean };
}

export function humanLabelForBlock(blockName: string): string {
  if (blockName === "__null__") return "Classic content";
  const parts = blockName.split("/");
  if (parts[0] === "cpt_template") {
    return `${titleCase(parts[1] ?? "Unknown")} template`;
  }
  // acf_flex/<cpt>/<field>/<layout> → label by the layout leaf.
  const leaf = parts[parts.length - 1] ?? blockName;
  return titleCase(leaf);
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface ReduceSiteMapInput {
  blockRows: Array<{
    block_name: string;
    tier: string | null;
    occurrence_count: number | null;
    compile_status: string | null;
    page_slugs: string[] | null;
  }>;
  pageRows: Array<{ slug: string; route_path: string; post_type: string }>;
  hasHeader: boolean;
  hasFooter: boolean;
}

export function reduceSiteMap(input: ReduceSiteMapInput): SiteMap {
  const blockTypes: SiteMapBlockType[] = input.blockRows
    // Only units that render AS THEIR OWN PATCHABLE COMPONENT are editable.
    // The dispatcher + draft artifacts builder render exactly
    // tier!=='passthrough' && compile_status==='ok' (compose-site-emit.ts:1197-1203,
    // artifacts.ts:124-126); offering anything else makes the draft-edit worker
    // patch an orphaned passthrough stub, mark the edit completed, and show the
    // user zero change with no error.
    // core/image ALSO passes that predicate but is always routed to the
    // MediaImage platform shim (emitDispatcherTsx suppresses the generated
    // CoreImage, compose-site-emit.ts:1219-1235; the draft builder excludes
    // core/image from component sources, artifacts.ts:63) — so patching it is a
    // no-op. Exclude it by name until a platform-shim edit path exists.
    .filter(
      (r) =>
        r.block_name !== "__null__" &&
        r.block_name !== "core/image" &&
        r.tier !== "passthrough" &&
        r.compile_status === "ok",
    )
    .map((r) => {
      const pageCount = (r.page_slugs ?? []).length;
      return {
        blockName: r.block_name,
        label: humanLabelForBlock(r.block_name),
        tier: r.tier,
        occurrenceCount: r.occurrence_count ?? 0,
        // page_slugs is capped at MAX_PAGE_SLUGS_PER_BLOCK; at the cap this is a
        // floor ("at least N"), so the planner must not state it as an exact count.
        pageCount,
        pageCountIsFloor: pageCount >= MAX_PAGE_SLUGS_PER_BLOCK,
      };
    })
    .sort((a, b) => {
      if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
      return a.blockName.localeCompare(b.blockName);
    });
  return {
    blockTypes,
    pageSlugs: input.pageRows.map((p) => p.slug),
    shell: { header: input.hasHeader, footer: input.hasFooter },
  };
}

/** Load the SOURCE build's block + page inventory and shell presence, then reduce. */
export async function buildSiteMap(sourceBuildId: string): Promise<SiteMap> {
  const supabase = createAdminClient();
  const [blocksRes, pagesRes, shellListing] = await Promise.all([
    supabase
      .from("block_inventory")
      .select("block_name, tier, occurrence_count, compile_status, page_slugs")
      .eq("site_build_id", sourceBuildId),
    supabase
      .from("page_inventory")
      .select("slug, route_path, post_type")
      .eq("site_build_id", sourceBuildId),
    listShellDir(sourceBuildId),
  ]);
  // Hard-fail the inventory reads. A swallowed DB error here would silently
  // collapse the planner's candidate set to empty, making it refuse every real
  // target — the loud-error rule (Global Constraints) applies. The ONLY
  // deliberate fail-soft is shell presence: listShellDir → decideShellPresence
  // fails CLOSED to "present", never to a false refusal.
  if (blocksRes.error) throw new Error(`buildSiteMap: block_inventory read failed: ${blocksRes.error.message}`);
  if (pagesRes.error) throw new Error(`buildSiteMap: page_inventory read failed: ${pagesRes.error.message}`);
  return reduceSiteMap({
    blockRows: (blocksRes.data ?? []) as ReduceSiteMapInput["blockRows"],
    pageRows: (pagesRes.data ?? []) as ReduceSiteMapInput["pageRows"],
    hasHeader: decideShellPresence("header", shellListing),
    hasFooter: decideShellPresence("footer", shellListing),
  });
}
