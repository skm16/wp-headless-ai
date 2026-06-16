import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { findLiveDraft } from "@/lib/db/drafts";
import { draftArtifactPath } from "@/lib/draft/artifacts";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { buildGoogleFontLinks } from "@/lib/jab/compose-site-emit";
import { resolveThemeTokens, type ThemeJsonTokens, type ScrapedBrandTokens } from "@/lib/jab/global-styles";

/**
 * /draft/[projectId]/ — HTML shell for the draft-preview iframe.
 *
 * Auth: HMAC token in ?token=; no cookies (iframe sandboxed without
 * allow-same-origin → opaque origin). The workspace RSC mints this token
 * only after RLS confirmed project membership.
 *
 * The shell sets window.__JAB_DRAFT__ then loads the versioned bundle.js as a
 * module script via the same-origin /api/draft/[projectId]/bundle asset route
 * (Storage serves it as text/plain on a cross-origin host — a module script can
 * load neither). CSS is inlined from the versioned draft.css; brand webfonts
 * are re-emitted as Google Fonts <link> tags (buildGoogleFontLinks) since they
 * live in the deployed <head>, not the bundled theme.css.
 *
 * ?v=N is advisory only — we always serve the draft's CURRENT version so
 * the iframe reflects live state even when the pane hasn't polled yet.
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
    return new NextResponse("No live draft", { status: 404 });
  }

  const storage = admin.storage.from(SITE_SCREENSHOTS_BUCKET);
  const cssPath = draftArtifactPath(draft.id, draft.version, "draft.css");
  const { data: cssFile, error: cssErr } = await storage.download(cssPath);
  if (cssErr || !cssFile) {
    return new NextResponse(`Draft CSS not found: ${cssPath}`, { status: 404 });
  }
  const css = await cssFile.text();

  // Brand fonts (e.g. Anton, Source Sans Pro) load from Google Fonts via <link>
  // tags in the deployed site's <head> (buildGoogleFontLinks + emitLayoutTsx) —
  // they are NOT in the captured/bundled theme.css. The draft shell builds its
  // own <head>, so without re-emitting those links here headings fall back to
  // a serif/system font. Mirror loadProjectMeta's token resolution.
  const { data: projectRow } = await admin
    .from("projects")
    .select("design_tokens")
    .eq("id", projectId)
    .single<{ design_tokens: unknown }>();
  const dt = (projectRow?.design_tokens ?? {}) as {
    themeJson?: ThemeJsonTokens | null;
    colors?: ScrapedBrandTokens["colors"];
    typography?: ScrapedBrandTokens["typography"];
  };
  const tokens = resolveThemeTokens(dt.themeJson, { colors: dt.colors, typography: dt.typography });
  const fontLinks = buildGoogleFontLinks(tokens);
  const fontLinkTags = fontLinks.length
    ? `\n  <link rel="preconnect" href="https://fonts.googleapis.com" />` +
      `\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />` +
      fontLinks.map((href) => `\n  <link rel="stylesheet" href="${href}" />`).join("")
    : "";

  // The bundle is stored as text/plain (the bucket disallows a JS MIME) and
  // lives on a cross-origin Storage host — a <script type="module"> can load
  // neither (MIME rejection + CORS). Serve it through the same-origin asset
  // route instead, which re-serves it as text/javascript. ?v= is cache-busting
  // only; the route always serves the draft's current version.
  const apiBase = `/api/draft/${projectId}`;
  const bundleSrc = `${apiBase}/bundle?token=${encodeURIComponent(token!)}&v=${draft.version}`;
  const initialPath = "/";

  const html = `<!DOCTYPE html>
<html id="jab-app" lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Draft preview</title>${fontLinkTags}
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__JAB_DRAFT__ = ${JSON.stringify({
      projectId,
      token: token!,
      apiBase,
      initialPath,
    })};
  </script>
  <script type="module" src="${bundleSrc}"></script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // No-store: the version is baked in, and the signed URL expires.
      "Cache-Control": "no-store",
    },
  });
}
