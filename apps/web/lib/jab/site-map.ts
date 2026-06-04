import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * site-map — compact, planner-facing description of a SOURCE build (spec §3.3).
 * buildSiteMap does the DB read; reduceSiteMap is the pure, unit-tested core.
 * The planner's `target` MUST be one of `blockTypes[].blockName` (component
 * scope) or a shell kind that is present (shell scope).
 */

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
  const [{ data: blocks }, { data: pages }, { data: shells }] = await Promise.all([
    supabase
      .from("block_inventory")
      .select("block_name, tier, occurrence_count")
      .eq("site_build_id", sourceBuildId),
    supabase
      .from("page_inventory")
      .select("slug, route_path, post_type")
      .eq("site_build_id", sourceBuildId),
    supabase.from("shell_generations").select("shell_kind").eq("site_build_id", sourceBuildId),
  ]);
  const shellKinds = new Set((shells ?? []).map((s) => (s as { shell_kind: string }).shell_kind));
  return reduceSiteMap({
    blockRows: (blocks ?? []) as ReduceSiteMapInput["blockRows"],
    pageRows: (pages ?? []) as ReduceSiteMapInput["pageRows"],
    hasHeader: shellKinds.has("header"),
    hasFooter: shellKinds.has("footer"),
  });
}
