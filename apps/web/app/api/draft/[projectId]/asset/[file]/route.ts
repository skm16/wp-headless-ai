import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { baseDraftArtifactPath } from "@/lib/draft/artifacts";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  "bundle.js": "text/javascript",
  "draft.css": "text/css",
};

/**
 * Streams pre-built draft artifacts from Storage with immutable cache headers.
 * The version cache-buster in the query string (?v=base-<buildId>) means the
 * filename is stable but the URL changes when artifacts are regenerated, so
 * `Cache-Control: immutable` is safe (per the spec §7.3 asset route).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; file: string }> },
) {
  const { projectId, file } = await ctx.params;
  const token = req.nextUrl.searchParams.get("token");
  if (!verifyDraftToken(projectId, token)) {
    return new NextResponse("draft token invalid or expired", { status: 401 });
  }

  const contentType = CONTENT_TYPES[file];
  if (!contentType) {
    return new NextResponse("not found", { status: 404 });
  }

  const buildVersion = req.nextUrl.searchParams.get("v") ?? "";
  const buildId = buildVersion.replace(/^base-/, "");
  if (!buildId) {
    return new NextResponse("missing v param", { status: 400 });
  }

  const admin = createAdminClient();

  // Verify the requested buildId belongs to this project before serving.
  // HMAC proves the caller owns projectId; this prevents cross-project asset
  // enumeration via a valid token + arbitrary buildId.
  const { data: build } = await admin
    .from("site_builds")
    .select("id")
    .eq("id", buildId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!build) {
    return new NextResponse("artifact not found", { status: 404 });
  }

  const storagePath = baseDraftArtifactPath(buildId, file as "bundle.js" | "draft.css");
  const { data, error } = await admin.storage.from(SITE_SCREENSHOTS_BUCKET).download(storagePath);
  if (error || !data) {
    return new NextResponse("artifact not found — run a build first", { status: 404 });
  }

  const bytes = await data.arrayBuffer();
  return new NextResponse(bytes, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
