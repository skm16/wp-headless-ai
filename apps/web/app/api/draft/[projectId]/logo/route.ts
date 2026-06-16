import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { createAdminClient } from "@/lib/supabase/admin";
import { PROJECT_ASSETS_BUCKET } from "@/lib/storage/bucket";

/**
 * /api/draft/[projectId]/logo?token=... — same-origin proxy for the project
 * logo in the draft preview.
 *
 * Why this exists: compose downloads project.logo_storage_path and bundles it
 * into the deployed project's /public/logo.<ext>, then the header emits
 * <img src="/logo.<ext>"> (see compose-site.ts bundle-logo). That resolves on
 * Vercel, but the draft iframe is a bundled runtime served from /draft/* with
 * NO project /public dir — so /logo.png 404s. The bundle route rewrites
 * /logo.<ext> → this proxy, which streams the canonical logo from the
 * project-assets bucket same-origin.
 *
 * Auth: the same HMAC token the shell mints (verifyDraftToken). No cookies —
 * the iframe is sandboxed without allow-same-origin (opaque origin).
 */

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case "svg":
      return "image/svg+xml";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const { projectId } = await params;
  const token = req.nextUrl.searchParams.get("token");

  if (!verifyDraftToken(projectId, token)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const admin = createAdminClient();
  const { data: project } = await admin
    .from("projects")
    .select("logo_storage_path")
    .eq("id", projectId)
    .single<{ logo_storage_path: string | null }>();

  const logoPath = project?.logo_storage_path;
  if (!logoPath) {
    return new NextResponse("No logo", { status: 404 });
  }

  const { data: file, error } = await admin.storage
    .from(PROJECT_ASSETS_BUCKET)
    .download(logoPath);
  if (error || !file) {
    return new NextResponse("Logo not found", { status: 404 });
  }

  const ext = (logoPath.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
  const bytes = Buffer.from(await file.arrayBuffer());
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentTypeForExt(ext),
      // Opaque-origin iframe — same rationale as the bundle/page routes.
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}
