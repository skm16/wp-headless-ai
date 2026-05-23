import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertHostnameSafe, SsrfError } from "./ssrf-guard";
import {
  PROJECT_ASSETS_BUCKET,
  ensureProjectAssetsBucket,
} from "@/lib/storage/bucket";

/**
 * Binary-asset fetcher + storage uploader for the wow-flow.
 *
 * Given a list of asset URLs identified during the scrape pass (logo,
 * favicon, OG image), downloads each over HTTPS (SSRF-guarded), uploads
 * to the `project-assets` bucket under `previews/<previewId>/<kind>.<ext>`,
 * and returns the bucket-relative storage paths.
 *
 * Failure mode: best-effort. If any individual asset can't be fetched or
 * uploaded, its path is `null` in the result; the others still land. This
 * matches the design plan §10 priority #2 framing — "small scope, immediate
 * visible win" — losing a favicon shouldn't fail the whole preview.
 *
 * Security posture:
 *   - HTTPS only (mirrors scrape-fetch.ts)
 *   - SSRF guard re-applied per URL — asset URLs come from inside scraped
 *     HTML, which an attacker could have crafted to embed an internal-network
 *     `<img src="https://10.0.0.5/...">` URL. The guard catches this.
 *   - Streaming size cap (2 MB per asset — generous for logos, restrictive
 *     vs. inlined SVG bombs)
 *   - Content-Type must be image/*
 *   - Timeout via AbortController
 *
 * One round-trip per asset. Three assets in parallel via Promise.allSettled.
 */

export type AssetKind = "logo" | "favicon" | "og";

export interface AssetCapturePlan {
  /** Logo URL (typically from the design-pass classification). */
  logo: string | null;
  /** `<link rel="icon">` or shortcut icon URL. */
  favicon: string | null;
  /** og:image / twitter:image URL. */
  ogImage: string | null;
}

export interface AssetCaptureResult {
  logoPath: string | null;
  faviconPath: string | null;
  ogImagePath: string | null;
  /**
   * Per-asset capture failures keyed by kind. Empty if everything worked.
   * Logged by callers; not surfaced publicly.
   */
  failures: Partial<Record<AssetKind, string>>;
}

export interface AssetCaptureOptions {
  /** Storage path prefix (e.g. `previews/<previewId>` or `projects/<projectId>`). */
  pathPrefix: string;
  /** Per-asset fetch timeout. Default 10s. */
  timeoutMs?: number;
  /** Per-asset max bytes. Default 2 MB. */
  maxBytes?: number;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 2 * 1024 * 1024,
} as const;

export async function captureAssets(
  plan: AssetCapturePlan,
  opts: AssetCaptureOptions,
): Promise<AssetCaptureResult> {
  // Lazy bucket bootstrap. Per-cold-start cost; subsequent calls no-op.
  await ensureProjectAssetsBucket();

  const kinds: Array<{ kind: AssetKind; url: string | null }> = [
    { kind: "logo", url: plan.logo },
    { kind: "favicon", url: plan.favicon },
    { kind: "og", url: plan.ogImage },
  ];

  const captured = await Promise.allSettled(
    kinds.map(async ({ kind, url }) => {
      if (!url) return { kind, path: null as string | null };
      const path = await captureOne(kind, url, opts);
      return { kind, path };
    }),
  );

  const result: AssetCaptureResult = {
    logoPath: null,
    faviconPath: null,
    ogImagePath: null,
    failures: {},
  };

  for (const [i, outcome] of captured.entries()) {
    const kind = kinds[i]!.kind;
    if (outcome.status === "fulfilled") {
      if (kind === "logo") result.logoPath = outcome.value.path;
      else if (kind === "favicon") result.faviconPath = outcome.value.path;
      else if (kind === "og") result.ogImagePath = outcome.value.path;
    } else {
      result.failures[kind] =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
    }
  }

  return result;
}

/** Maximum redirect hops to follow during an asset fetch. */
const MAX_REDIRECTS = 3;

/**
 * Fetch one asset URL + upload to Supabase Storage. Returns the
 * bucket-relative path on success; throws on any failure (caller in
 * captureAssets() collects via Promise.allSettled so one bad asset
 * doesn't block the others).
 */
async function captureOne(
  kind: AssetKind,
  rawUrl: string,
  opts: AssetCaptureOptions,
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  // ONE AbortController spans the SSRF check, every redirect hop, AND
  // the body read. A slow-trickle server (headers in 50ms, body at 1
  // B/s) would otherwise tie up a worker indefinitely; a stalled
  // redirect chain would too.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchWithSsrfSafeRedirects(url, controller.signal);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/^image\//i.test(contentType)) {
      throw new Error(`Not an image (content-type=${contentType || "missing"})`);
    }

    if (!response.body) {
      throw new Error("Empty response body");
    }

    let bytes: Uint8Array;
    try {
      bytes = await readWithCap(response.body, maxBytes);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Timed out reading body after ${timeoutMs}ms`);
      }
      throw err;
    }

    const finalUrl = new URL(response.url || url.toString());
    const ext = extensionFromContentType(contentType, finalUrl.pathname);
    const storagePath = `${opts.pathPrefix}/${kind}.${ext}`;

    const supabase = createAdminClient();
    // upsert: true so a retry on the same prefix overwrites instead of
    // erroring on "already exists." `cacheControl` is moderate — these
    // are public assets that won't change often, but we may rebrand and
    // the new file should win within a few minutes.
    const { error: uploadErr } = await supabase.storage
      .from(PROJECT_ASSETS_BUCKET)
      .upload(storagePath, bytes, {
        contentType,
        upsert: true,
        cacheControl: "300",
      });

    if (uploadErr) {
      throw new Error(`Upload failed: ${uploadErr.message}`);
    }

    return storagePath;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET `url` with SSRF re-checked on every redirect hop. Mirrors the
 * pattern in scrape-fetch.ts but optimized for binary fetch: no
 * Accept-Language, image/* Accept header, smaller redirect budget.
 *
 * `redirect: "follow"` is NOT safe here — an attacker-controlled HTML
 * embed could point at a public host that 302s to
 * http://169.254.169.254/ (AWS metadata) — Node's fetch would follow
 * transparently, the bytes would land in our public bucket as an opaque
 * blob, then be exfiltrable via the public URL. Manual redirect mode
 * + per-hop SSRF re-check closes this.
 *
 * Throws on: HTTPS-only violation, SSRF rejection at any hop, timeout
 * (via AbortSignal), too many redirects, network error.
 */
async function fetchWithSsrfSafeRedirects(
  startUrl: URL,
  signal: AbortSignal,
): Promise<Response> {
  let url = startUrl;
  let hopsRemaining = MAX_REDIRECTS;

  while (true) {
    if (url.protocol !== "https:") {
      throw new Error(`Asset URL not HTTPS: ${url.toString()}`);
    }
    try {
      await assertHostnameSafe(url.hostname);
    } catch (err) {
      if (err instanceof SsrfError) {
        throw new Error(`Refused to fetch asset: ${err.message}`);
      }
      throw err;
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": "JabBot/0.1 (+https://jabwp.app/bot)",
          Accept: "image/*",
        },
      });
    } catch (err) {
      if (signal.aborted) {
        throw new Error(`Timed out`);
      }
      throw new Error(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`${response.status} redirect without Location header`);
      }
      if (hopsRemaining <= 0) {
        throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new Error(`Invalid redirect Location: ${location}`);
      }
      // Cancel the unused redirect body so the connection can be
      // released back to the pool before we issue the next request.
      await response.body?.cancel().catch(() => undefined);
      url = next;
      hopsRemaining -= 1;
      continue;
    }

    // 2xx (or any non-redirect) — caller takes ownership of the body.
    return response;
  }
}

async function readWithCap(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Asset exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Pick a sensible extension for the saved file. Content-Type wins; URL
 * pathname is the fallback. We default to `bin` if both fail, so the
 * upload still succeeds even if the source server lies about its
 * content-type.
 */
function extensionFromContentType(contentType: string, pathname: string): string {
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  const fromType: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
  };
  if (fromType[ct]) return fromType[ct];
  const pathExt = pathname.split(".").pop()?.toLowerCase();
  if (pathExt && /^(png|jpe?g|gif|webp|svg|ico)$/i.test(pathExt)) {
    return pathExt === "jpeg" ? "jpg" : pathExt;
  }
  return "bin";
}
