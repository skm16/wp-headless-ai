import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Safe HTML fetcher for the public `/preview` scrape agent.
 *
 * The user pastes an arbitrary URL, so this layer is paranoid by design:
 *   - HTTPS only (per design plan §10 #2 — also closes part of SEC-3's
 *     SSRF surface by refusing redirect chains that downgrade)
 *   - DNS resolution + IP allow-check before connect (no loopback, no
 *     RFC1918, no link-local, no metadata services)
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
  await assertHostnameSafe(url.hostname);

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

/**
 * Block hostnames that resolve to private / link-local / loopback addresses,
 * plus the AWS / GCP metadata service IPs that are the textbook SSRF target.
 *
 * Limitations: a DNS rebinding attack could swap the answer between this
 * check and the actual fetch. Mitigating that properly needs pinning the IP
 * and bypassing DNS on the fetch — out of scope for v1; acceptable since the
 * blast radius here is "render scraped HTML into an LLM prompt," not
 * "execute arbitrary code." Re-evaluate if a higher-stakes endpoint reuses
 * this module.
 */
async function assertHostnameSafe(hostname: string): Promise<void> {
  const lower = hostname.toLowerCase();

  // Reject literal localhost-ish hostnames before DNS — some resolvers will
  // return 127.0.0.1, some won't, and we don't want to depend on that.
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower === "metadata.google.internal"
  ) {
    throw new ScrapeFetchError(
      `Refusing to fetch from ${hostname}`,
      "private_address",
    );
  }

  // If the user passed a raw IP, validate that directly.
  if (isIP(lower)) {
    if (!isPublicIp(lower)) {
      throw new ScrapeFetchError(
        `Refusing to fetch from ${hostname} (private/reserved address)`,
        "private_address",
      );
    }
    return;
  }

  // DNS lookup. Resolve all answers — a hostname can A-record both a public
  // and a private IP; we reject the whole name if any answer is private.
  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(hostname, { all: true });
  } catch (err) {
    throw new ScrapeFetchError(
      `Couldn't resolve ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
      "network",
      err,
    );
  }

  if (answers.length === 0) {
    throw new ScrapeFetchError(`No DNS answer for ${hostname}`, "network");
  }

  for (const answer of answers) {
    if (!isPublicIp(answer.address)) {
      throw new ScrapeFetchError(
        `${hostname} resolves to a private/reserved address (${answer.address})`,
        "private_address",
      );
    }
  }
}

/**
 * Returns true for routable, public unicast addresses. Rejects every range
 * that has a special meaning per RFC 1918, 6890, 4193, etc.
 */
function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 — "this network"
  if (a === 0) return false;
  // 10.0.0.0/8 — RFC 1918
  if (a === 10) return false;
  // 100.64.0.0/10 — RFC 6598 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return false;
  // 127.0.0.0/8 — loopback
  if (a === 127) return false;
  // 169.254.0.0/16 — link-local + AWS/GCP metadata (169.254.169.254)
  if (a === 169 && b === 254) return false;
  // 172.16.0.0/12 — RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 0) return false;
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — TEST-NETs
  if (a === 192 && b === 0 && parts[2] === 2) return false;
  if (a === 198 && b === 51 && parts[2] === 100) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  // 192.168.0.0/16 — RFC 1918
  if (a === 192 && b === 168) return false;
  // 198.18.0.0/15 — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return false;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return false;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return false;

  return true;
}

function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase();

  // ::1 — loopback
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return false;
  // :: — unspecified
  if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return false;
  // fc00::/7 — unique local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return false;
  // fe80::/10 — link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return false;
  // ::ffff:0:0/96 — IPv4-mapped — fall back to v4 rules on the embedded addr
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPublicIpv4(v4Mapped[1]!);
  // ff00::/8 — multicast
  if (lower.startsWith("ff")) return false;

  return true;
}
