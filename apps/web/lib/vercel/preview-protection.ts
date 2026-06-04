// apps/web/lib/vercel/preview-protection.ts
/**
 * preview-protection — detect Vercel team-level Deployment Protection.
 *
 * When an org enables SSO/Deployment Protection, every preview URL returns
 * 401/403 behind a Vercel auth wall. The iframe then shows a blank/login
 * page and the whole live-preview feature looks broken. This guard fires a
 * cheap HEAD (falling back to GET) and throws a tagged PreviewProtectedError
 * on 401/403 so callers can surface a loud, actionable banner instead of a
 * silent blank frame (spec §3.2, R5).
 *
 * Deliberately fail-soft on everything else: a network blip or a 404 is NOT
 * protection, so we resolve quietly and let the iframe attempt the load.
 */

export class PreviewProtectedError extends Error {
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number) {
    super(
      `Preview is protected (HTTP ${status}). Disable Vercel Deployment Protection for previews, or grant access, then reload. URL: ${url}`,
    );
    this.name = "PreviewProtectedError";
    this.url = url;
    this.status = status;
  }
}

async function probe(url: string, method: "HEAD" | "GET"): Promise<number | null> {
  try {
    const res = await fetch(url, { method, redirect: "manual" });
    return res.status;
  } catch {
    // Network error — unknown, not protection.
    return null;
  }
}

/**
 * Throws PreviewProtectedError if the preview URL is gated behind Vercel
 * Deployment Protection (401/403). Resolves for any other outcome.
 */
export async function assertPreviewReachable(url: string): Promise<void> {
  // HEAD first (cheap); some Vercel routes 405 HEAD, so fall back to GET.
  let status = await probe(url, "HEAD");
  if (status === null || status === 405) {
    status = await probe(url, "GET");
  }
  if (status === 401 || status === 403) {
    throw new PreviewProtectedError(url, status);
  }
}
