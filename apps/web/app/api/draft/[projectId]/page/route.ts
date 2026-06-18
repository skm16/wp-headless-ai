import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { findLiveDraft } from "@/lib/db/drafts";
import { loadDraftPageData, defaultDraftPageDeps } from "@/lib/draft/page-data";
import { createAdminClient } from "@/lib/supabase/admin";

// Per-request Supabase reads make this route inherently dynamic (carried from master).
export const dynamic = "force-dynamic";

/**
 * /api/draft/[projectId]/page?path=...&token=... — block data endpoint for
 * the draft-preview runtime (entry.tsx fetchPage, which requests `${apiBase}/page`).
 * Token-authenticated only; no cookies (opaque origin in sandboxed iframe).
 *
 * Returns the same shapes entry.tsx expects:
 *   { kind: "page"; blocks: RenderableBlock[] }
 *   { kind: "blogIndex"; heading: string; items: JabListItem[] }
 *   { kind: "redirect"; to: string }
 *   { kind: "not_found" }
 *   { kind: "error"; message: string }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const { projectId } = await params;
  const token = req.nextUrl.searchParams.get("token");
  const path = req.nextUrl.searchParams.get("path") ?? "/";

  // The draft iframe is sandboxed without allow-same-origin (opaque/null origin
  // — see workspace-preview-pane.tsx), so the bundle's runtime fetchPage() is a
  // cross-origin read. Without ACAO the browser blocks the response body even
  // on a 200, surfacing as "NetworkError" in the preview. Token-gated; allow it.
  const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };

  if (!verifyDraftToken(projectId, token)) {
    return NextResponse.json({ kind: "error", message: "Unauthorized" }, { status: 401, headers });
  }

  const admin = createAdminClient();
  const { data: project, error: projectErr } = await admin
    .from("projects")
    .select("id, tenant_id")
    .eq("id", projectId)
    .single<{ id: string; tenant_id: string }>();
  if (projectErr || !project) {
    return NextResponse.json({ kind: "not_found" }, { status: 404, headers });
  }

  const draft = await findLiveDraft(projectId);
  if (!draft || draft.version === 0) {
    return NextResponse.json({ kind: "not_found" }, { status: 404, headers });
  }

  const deps = await defaultDraftPageDeps(projectId, project.tenant_id);
  const result = await loadDraftPageData({ buildId: draft.base_build_id, path }, deps);

  return NextResponse.json(result, {
    status:
      result.kind === "not_found" ? 404 : result.kind === "error" ? 500 : 200,
    headers,
  });
}
