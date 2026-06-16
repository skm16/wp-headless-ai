import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { findLiveDraft } from "@/lib/db/drafts";
import { draftArtifactPath } from "@/lib/draft/artifacts";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

/**
 * /api/draft/[projectId]/bundle?token=...&v=N — same-origin asset proxy for the
 * draft-preview runtime bundle.
 *
 * Why this exists: the bundle is stored in Storage as `text/plain` (the
 * SITE_SCREENSHOTS_BUCKET allowedMimeTypes don't include a JS type — see
 * lib/draft/artifacts.ts). A `<script type="module">` cannot load it directly
 * from the Storage signed URL: the browser rejects the `text/plain` MIME for a
 * module AND the Storage origin is cross-origin to the sandboxed iframe (CORS
 * fails). artifacts.ts already anticipated this — "the asset route sets the
 * correct Content-Type header when serving them" — this is that route.
 *
 * We download the object server-side with the admin client and re-serve it
 * same-origin with `Content-Type: text/javascript`. No signed URL, no CORS, no
 * MIME rejection.
 *
 * Auth: the same HMAC token the shell mints (verifyDraftToken). No cookies —
 * the iframe is sandboxed without allow-same-origin (opaque origin).
 *
 * ?v=N is advisory only (cache-busting); we always serve the draft's CURRENT
 * version so the iframe reflects live state, matching the shell route.
 */
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
  const draft = await findLiveDraft(projectId);
  if (!draft || draft.version === 0) {
    return new NextResponse("// No live draft", {
      status: 404,
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  }

  const bundlePath = draftArtifactPath(draft.id, draft.version, "bundle.js");
  const { data: file, error } = await admin.storage
    .from(SITE_SCREENSHOTS_BUCKET)
    .download(bundlePath);
  if (error || !file) {
    return new NextResponse(`// Draft bundle not found: ${bundlePath}`, {
      status: 404,
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
    });
  }

  const js = await file.text();
  return new NextResponse(js, {
    status: 200,
    headers: {
      // The whole point of the proxy: a module-loadable MIME, same-origin.
      "Content-Type": "text/javascript; charset=utf-8",
      // The draft iframe is sandboxed WITHOUT allow-same-origin (opaque/null
      // origin — see workspace-preview-pane.tsx), so even though we serve from
      // the same host, the iframe sees this as cross-origin and a
      // <script type="module"> enforces CORS. Allow it: the bundle is
      // non-sensitive compiled UI and the route is already token-gated.
      "Access-Control-Allow-Origin": "*",
      // No-store: the version is resolved live and the body is version-specific.
      "Cache-Control": "no-store",
    },
  });
}
