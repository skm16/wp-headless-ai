import "server-only";
import { assertHostnameSafe, SsrfError } from "./ssrf-guard";

/**
 * Safe HTML fetcher for the public `/preview` scrape agent.
 *
 * The user pastes an arbitrary URL, so this layer is paranoid by design:
 *   - HTTPS only (per design plan §10 #2 — also closes part of SEC-3's
 *     SSRF surface by refusing redirect chains that downgrade)
 *   - DNS resolution + IP allow-check before connect (no loopback, no
 *     RFC1918, no link-local, no metadata services) — via `ssrf-guard.ts`
 *   - Redirect limit + per-hop SSRF re-check on each Location header
 *   - Streaming size cap (don't download 200 MB of inlined SVG)
 *   - Timeout via AbortController
 *   - Content-Type must be HTML
 *
 * The cost of a bad URL slipping through here is real: it's a server-side
 * fetch with our IP, against the public internet, that ends up rendering
 * its bytes into an LLM prompt. Treat it like a webhook target.
 */

export class ScrapeFetchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid_url"
      | "not_https"
      | "private_address"
      | "timeout"
      | "too_large"
      | "bad_content_type"
      | "too_many_redirects"
      | "http_error"
      | "network",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScrapeFetchError";
  }
}

export interface ScrapeFetchResult {
  /** Final URL after redirects (or input if none). */
  finalUrl: string;
  /** Decoded HTML body. */
  html: string;
  /** Reported content-type header. */
  contentType: string;
  /** Bytes received (before decode). */
  byteSize: number;
}

export interface ScrapeFetchOptions {
  /** AbortController timeout in ms. Default 15000. */
  timeoutMs?: number;
  /** Max bytes to read from the body. Default 3 MB. */
  maxBytes?: number;
  /** Max redirect hops to follow. Default 5. */
  maxRedirects?: number;
  /** UA to identify the bot on the target's logs. */
  userAgent?: string;
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxBytes: 3 * 1024 * 1024,
  maxRedirects: 5,
  userAgent: "JabBot/0.1 (+https://jabwp.app/bot)",
} as const;

export async function fetchHtmlSafely(
  rawUrl: string,
  opts: ScrapeFetchOptions = {},
): Promise<ScrapeFetchResult> {
  const o = { ...DEFAULTS, ...opts };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ScrapeFetchError(
      `Not a valid URL: ${rawUrl}`,
      "invalid_url",
    );
  }

  // Per design plan §10 #2 — HTTPS only. Also short-circuits SSRF vectors
  // that try to bounce through http:// to a private host.
  if (url.protocol !== "https:") {
    throw new ScrapeFetchError(
      `URL must use https:// (got ${url.protocol})`,
      "not_https",
    );
  }

  return fetchWithRedirects(url, o, /* hopsRemaining */ o.maxRedirects);
}

async function fetchWithRedirects(
  url: URL,
  o: Required<ScrapeFetchOptions>,
  hopsRemaining: number,
): Promise<ScrapeFetchResult> {
  // SSRF guard. Maps shared `SsrfError` → fetcher-specific `ScrapeFetchError`
  // so the caller's discriminated-union switch still works.
  try {
    await assertHostnameSafe(url.hostname);
  } catch (err) {
    if (err instanceof SsrfError) {
      const code =
        err.code === "private_address" ? "private_address" : "network";
      throw new ScrapeFetchError(err.message, code, err);
    }
    throw err;
  }

  // Single AbortController spans BOTH the connect/headers phase AND the
  // body read. A slow-trickle server that sends headers in 50ms and body
  // at 1 B/s would otherwise tie up a worker for the full size-cap window.
  // We clear the timeout only after readWithCap finishes (success or fail).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), o.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": o.userAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new ScrapeFetchError(
        `Timed out fetching ${url.hostname} after ${o.timeoutMs}ms`,
        "timeout",
        err,
      );
    }
    throw new ScrapeFetchError(
      `Network error fetching ${url.hostname}: ${err instanceof Error ? err.message : String(err)}`,
      "network",
      err,
    );
  }

  try {
    // Manual redirect handling — every hop gets re-validated against the SSRF
    // rules. A 301 to http://localhost would otherwise bypass the entry check.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new ScrapeFetchError(
          `${response.status} redirect without Location header from ${url.hostname}`,
          "http_error",
        );
      }
      if (hopsRemaining <= 0) {
        throw new ScrapeFetchError(
          `Too many redirects from ${url.hostname}`,
          "too_many_redirects",
        );
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, url);
      } catch {
        throw new ScrapeFetchError(
          `Invalid redirect Location: ${location}`,
          "http_error",
        );
      }
      if (nextUrl.protocol !== "https:") {
        throw new ScrapeFetchError(
          `Redirect downgraded to ${nextUrl.protocol}`,
          "not_https",
        );
      }
      // Cancel THIS hop's timer before recursing — the next hop installs
      // a fresh one so the per-hop deadline doesn't accumulate.
      clearTimeout(timeout);
      return await fetchWithRedirects(nextUrl, o, hopsRemaining - 1);
    }

    if (!response.ok) {
      throw new ScrapeFetchError(
        `${response.status} ${response.statusText} from ${url.hostname}`,
        "http_error",
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
      throw new ScrapeFetchError(
        `Expected HTML, got ${contentType || "no content-type"}`,
        "bad_content_type",
      );
    }

    if (!response.body) {
      throw new ScrapeFetchError(
        `Empty response body from ${url.hostname}`,
        "http_error",
      );
    }

    let bytes: Uint8Array;
    let byteSize: number;
    try {
      ({ bytes, byteSize } = await readWithCap(
        response.body,
        o.maxBytes,
        url.hostname,
      ));
    } catch (err) {
      // The body read aborts cleanly when the AbortController fires —
      // surface it as a timeout, not a generic network error, so the
      // public-error mapping picks the right copy.
      if (controller.signal.aborted) {
        throw new ScrapeFetchError(
          `Timed out reading body from ${url.hostname} after ${o.timeoutMs}ms`,
          "timeout",
          err,
        );
      }
      throw err;
    }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    return {
      finalUrl: url.toString(),
      html,
      contentType,
      byteSize,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readWithCap(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  hostname: string,
): Promise<{ bytes: Uint8Array; byteSize: number }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Cancel — don't drain the rest. The remote server's bandwidth is
        // not our concern; ours is.
        await reader.cancel().catch(() => undefined);
        throw new ScrapeFetchError(
          `Response from ${hostname} exceeded ${maxBytes} bytes`,
          "too_large",
        );
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
  return { bytes: merged, byteSize: total };
}

