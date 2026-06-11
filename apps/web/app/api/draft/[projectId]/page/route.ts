import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { loadDraftPageData, defaultDraftPageDeps } from "@/lib/draft/page-data";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Returns page data JSON for the draft renderer's client-side navigation.
 * Called by entry.tsx when the user navigates to a new path within the iframe.
 * The HMAC token is re-verified on every call (same opaque-origin restriction
 * as the shell route — no cookies cross the sandbox boundary).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await ctx.params;
  const token = req.nextUrl.searchParams.get("token");
  if (!verifyDraftToken(projectId, token)) {
    return NextResponse.json({ error: "draft token invalid or expired" }, { status: 401 });
  }

  const path = req.nextUrl.searchParams.get("path") ?? "/";

  const admin = createAdminClient();
  const [{ data: project }, { data: build }] = await Promise.all([
    admin.from("projects").select("tenant_id").eq("id", projectId).single(),
    admin
      .from("site_builds")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "ready")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!build) {
    return NextResponse.json({ error: "no ready build" }, { status: 404 });
  }

  const deps = await defaultDraftPageDeps(projectId, (project?.tenant_id as string) ?? "");
  const result = await loadDraftPageData({ buildId: build.id, path }, deps);

  if (result.kind === "redirect") {
    return NextResponse.json({ kind: "redirect", to: result.to });
  }
  if (result.kind === "not_found") {
    return NextResponse.json({ kind: "not_found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
