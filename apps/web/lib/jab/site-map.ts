import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

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
 * the file in Storage without writing a telemetry row (proven on build
 * 394e1456). When the Storage listing itself fails we fail CLOSED to "present":
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
  blockRows: Array<{ block_name: string; tier: string | null; occurrence_count: number | null }>;
  pageRows: Array<{ slug: string; route_path: string; post_type: string }>;
  hasHeader: boolean;
  hasFooter: boolean;
}

export function reduceSiteMap(input: ReduceSiteMapInput): SiteMap {
  const blockTypes: SiteMapBlockType[] = input.blockRows
    .filter((r) => r.block_name !== "__null__")
    .map((r) => ({
      blockName: r.block_name,
      label: humanLabelForBlock(r.block_name),
      tier: r.tier,
      occurrenceCount: r.occurrence_count ?? 0,
    }))
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
