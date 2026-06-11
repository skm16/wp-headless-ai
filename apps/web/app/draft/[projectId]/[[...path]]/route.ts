import { NextRequest, NextResponse } from "next/server";
import { verifyDraftToken } from "@/lib/draft/token";
import { renderDraftShellHtml } from "@/lib/draft/html-shell";
import { ensureBaseDraftArtifacts, defaultArtifactDeps } from "@/lib/draft/artifacts";
import { buildGoogleFontLinks } from "@/lib/jab/compose-site-emit";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveThemeTokens } from "@/lib/jab/global-styles";

export const dynamic = "force-dynamic";

/**
 * Serves the draft HTML shell. AUTHZ = the HMAC token (the iframe is
 * sandboxed without allow-same-origin → opaque origin → no cookies), so we
 * use the admin client keyed by the token-verified projectId. The CSP keeps
 * the LLM-generated bundle from talking to anything but this app + media
 * origins (spec §7.1).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ projectId: string; path?: string[] }> },
) {
  const { projectId, path = [] } = await ctx.params;
  const token = req.nextUrl.searchParams.get("token");
  if (!verifyDraftToken(projectId, token)) {
    return new NextResponse("draft token invalid or expired", { status: 401 });
  }

  const admin = createAdminClient();
  const { data: build, error } = await admin
    .from("site_builds")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !build) {
    return new NextResponse("no ready build to preview — run a build first", { status: 404 });
  }

  try {
    await ensureBaseDraftArtifacts({ buildId: build.id }, defaultArtifactDeps(projectId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new NextResponse(`draft artifacts failed to build: ${msg}`, { status: 500 });
  }

  const { data: project } = await admin
    .from("projects")
    .select("design_tokens")
    .eq("id", projectId)
    .single();
  const dt = (project?.design_tokens ?? {}) as { themeJson?: unknown; scraped?: unknown };
  const tokens = resolveThemeTokens(dt.themeJson as never, dt.scraped as never);

  const html = renderDraftShellHtml({
    projectId,
    token: token as string,
    initialPath: "/" + path.join("/"),
    fontLinkHrefs: buildGoogleFontLinks(tokens),
    version: `base-${build.id}`,
  });
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src * data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
    },
  });
}
