import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard primitives shared by every server-side fetch that targets a
 * user-supplied URL. Extracted from `scrape-fetch.ts` so the asset-capture
 * pipeline (and any future fetcher) can use the same checks without
 * copy-pasting a 100-line block of CIDR ranges.
 *
 * Each fetcher wraps the guard in its own error type — `assertHostnameSafe`
 * throws an `SsrfError` with a stable `code`, which the caller maps to the
 * fetcher's domain-specific error class.
 *
 * Limitations: a DNS rebinding attack could swap the answer between this
 * check and the actual fetch. Mitigating that properly needs pinning the IP
 * and bypassing DNS on the fetch — out of scope for v1; the blast radius
 * here is "render scraped HTML / cache fetched binary in storage," not
 * "execute arbitrary code." Re-evaluate before any higher-stakes endpoint
 * reuses this module.
 */

export class SsrfError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "private_address"
      | "dns_resolution_failed"
      | "no_dns_answer",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SsrfError";
  }
}

/**
 * Throws `SsrfError` if the hostname resolves to a private / reserved /
 * loopback / metadata address. Used as the entry-point check on every
 * fetch and re-applied on every redirect hop.
 */
export async function assertHostnameSafe(hostname: string): Promise<void> {
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
    throw new SsrfError(
      `Refusing to fetch from ${hostname}`,
      "private_address",
    );
  }

  // If the user passed a raw IP, validate that directly.
  if (isIP(lower)) {
    if (!isPublicIp(lower)) {
      throw new SsrfError(
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
    throw new SsrfError(
      `Couldn't resolve ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
      "dns_resolution_failed",
      err,
    );
  }

  if (answers.length === 0) {
    throw new SsrfError(`No DNS answer for ${hostname}`, "no_dns_answer");
  }

  for (const answer of answers) {
    if (!isPublicIp(answer.address)) {
      throw new SsrfError(
        `${hostname} resolves to a private/reserved address (${answer.address})`,
        "private_address",
      );
    }
  }
}

/**
 * Returns true for routable, public unicast addresses. Rejects every range
 * that has a special meaning per RFC 1918, 6598, 6890, 4193, etc.
 */
export function isPublicIp(address: string): boolean {
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

  // ::ffff:0:0/96 — IPv4-mapped. Two surface forms:
  //   1. Dotted-decimal: `::ffff:169.254.169.254` (Node's lookup output)
  //   2. Hex-encoded:    `::ffff:a9fe:a9fe`       (valid URL host literal)
  // Both must be rejected on a private/reserved embedded address —
  // otherwise an attacker constructs `https://[::ffff:a9fe:a9fe]/...`
  // (== 169.254.169.254, the AWS metadata IP) and bypasses the v4 rules.
  const v4MappedDotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedDotted) return isPublicIpv4(v4MappedDotted[1]!);
  const v4MappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1]!, 16);
    const lo = parseInt(v4MappedHex[2]!, 16);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi <= 0xffff && lo <= 0xffff) {
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPublicIpv4(dotted);
    }
  }

  // ff00::/8 — multicast
  if (lower.startsWith("ff")) return false;

  return true;
}
