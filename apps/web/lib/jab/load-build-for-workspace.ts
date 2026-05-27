import "server-only";
import { buildComponentStoragePath } from "@/lib/ai/persist-generation";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Workspace build loader — fetches the latest completed Phase B build for a
 * project and downloads its generated component TSX files for in-browser
 * review in the workspace Code panel.
 *
 * Selection: most recent site_build with status in ('composing', 'verifying',
 * 'ready'). 'composing' is included because Phase A standalone smoke runs
 * leave the build at 'composing' until Stage 7's orchestrator flips onward —
 * but the components are persisted at that point, so they're viewable.
 *
 * Returns null when no completed build exists yet (project not run through
 * Phase B). Callers fall back to the demo's mocked Liquid templates in that
 * case so the workspace UI remains non-empty.
 *
 * Auth posture: uses the service-role admin client (not the request-scoped
 * server client). The `site-screenshots` bucket is private and has no RLS
 * policy permitting authenticated reads — only the worker (service role)
 * writes there. Caller MUST validate tenant access to the project before
 * calling this; the projectId filter alone is the scoping check. The
 * workspace page does this via its prior RLS-enforced projects query —
 * if that returned a row, the caller is authorized for projectId.
 *
 * Performance: a typical pilot build has ~20 components averaging ~5 KB
 * each. Downloads run in parallel via Promise.all; total wall time on the
 * server is bounded by the slowest single download (~200–500 ms cold).
 * Storage download failures fall through with an empty `tsx` field rather
 * than failing the whole loader — preserves the metadata view (file list +
 * compile status) even when the content is unreachable.
 */

export interface WorkspaceBuildComponent {
  blockName: string;
  fileName: string;
  kind: "block" | "acf_flex" | "cpt_template";
  tier: string;
  compileStatus: "ok" | "failed" | "skipped" | null;
  tsx: string;
}

export interface WorkspaceBuild {
  buildId: string;
  componentCount: number;
  blockTypeCount: number;
  components: WorkspaceBuildComponent[];
}

interface BuildInventoryRow {
  block_name: string;
  kind: string | null;
  tier: string | null;
  compile_status: string | null;
}

const COMPLETED_PHASE_B_STATUSES = ["composing", "verifying", "ready"];

export async function loadLatestBuildForWorkspace(
  projectId: string,
): Promise<WorkspaceBuild | null> {
  const supabase = createAdminClient();
  const { data: build } = await supabase
    .from("site_builds")
    .select("id, component_count, block_type_count")
    .eq("project_id", projectId)
    .in("status", COMPLETED_PHASE_B_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; component_count: number | null; block_type_count: number | null }>();

  if (!build) return null;

  const { data: rows } = await supabase
    .from("block_inventory")
    .select("block_name, kind, tier, compile_status")
    .eq("site_build_id", build.id)
    .order("kind", { ascending: true })
    .order("block_name", { ascending: true });

  const inventory = (rows ?? []) as BuildInventoryRow[];

  const components = await Promise.all(
    inventory.map(async (row): Promise<WorkspaceBuildComponent> => {
      const kind = (row.kind ?? "block") as WorkspaceBuildComponent["kind"];
      const path = buildComponentStoragePath(build.id, row.block_name);
      const fileName = path.split("/").pop() ?? `${row.block_name}.tsx`;
      let tsx = "";
      try {
        const { data, error } = await supabase.storage
          .from(SITE_SCREENSHOTS_BUCKET)
          .download(path);
        if (!error && data) tsx = await data.text();
      } catch {
        // Fall through — surface metadata even if content can't be loaded.
      }
      return {
        blockName: row.block_name,
        fileName,
        kind,
        tier: row.tier ?? "passthrough",
        compileStatus: row.compile_status as WorkspaceBuildComponent["compileStatus"],
        tsx,
      };
    }),
  );

  return {
    buildId: build.id,
    componentCount: build.component_count ?? 0,
    blockTypeCount: build.block_type_count ?? 0,
    components,
  };
}
