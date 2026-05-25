import "server-only";
import type { ScrapeFetchError } from "./scrape-fetch";
import type { ScrapeAgentError } from "./scrape-agent";
import type { PreviewRendererError } from "./preview-renderer";

/**
 * Public-facing error mapping for the wow-preview pipeline.
 *
 * The pipeline throws richly-typed errors with discriminated `code` fields
 * (`ScrapeFetchError.code`, `ScrapeAgentError.code`, `PreviewRendererError.code`).
 * The worker persists those errors' `.message` to `anonymous_previews.error`,
 * and the server action returns that text verbatim to the user — which leaks
 * internal detail (resolved IPs, Anthropic stack traces, hostnames).
 *
 * This module takes a thrown error and produces:
 *   - a stable internal `code` that telemetry can group on
 *   - a public message that's safe to render in the user's browser
 *
 * The internal raw message is still logged server-side via the worker's
 * step.run() so we don't lose debug context.
 *
 * Copy aligns with `docs/saas-failure-states.md` where applicable.
 */

export type PublicErrorCode =
  | "invalid_url"
  | "not_https"
  | "site_unreachable"
  | "site_too_large"
  | "site_not_html"
  | "site_returned_error"
  | "site_blocked"
  | "ai_failed"
  | "render_failed"
  | "unknown";

export interface PublicError {
  code: PublicErrorCode;
  message: string;
}

const MESSAGES: Record<PublicErrorCode, string> = {
  invalid_url: "That doesn't look like a valid URL. Double-check and try again.",
  not_https:
    "We need the site to use https://. Most hosts include a free SSL certificate — talk to your host or check the site's settings.",
  site_unreachable:
    "We couldn't reach that site. Check the URL, or try again in a minute.",
  site_too_large:
    "That homepage is too large for us to read right now. Try a different page on the site, or contact us if you'd like help.",
  site_not_html:
    "That URL didn't return an HTML page. Make sure it's the public homepage, not an image or PDF.",
  site_returned_error:
    "The site returned an error when we tried to read it. Try again, or check that it's publicly accessible.",
  site_blocked:
    "We can't preview that URL. If you think it should work, contact us.",
  ai_failed:
    "We couldn't finalize this preview. Try again — this usually clears on retry.",
  render_failed:
    "We couldn't build the preview from your site. Try again in a moment.",
  unknown:
    "Something went wrong generating your preview. Try again, or contact us if it keeps happening.",
};

/**
 * Map a thrown error to a public-safe shape. Anything we don't recognize
 * falls through to `unknown` — the raw cause is intentionally NOT exposed.
 */
export function toPublicError(err: unknown): PublicError {
  if (!err || typeof err !== "object") {
    return { code: "unknown", message: MESSAGES.unknown };
  }

  const named = err as { name?: unknown; code?: unknown };

  if (named.name === "ScrapeFetchError") {
    return mapFetch(named.code as ScrapeFetchError["code"]);
  }
  if (named.name === "ScrapeAgentError") {
    return mapAgent(named.code as ScrapeAgentError["code"]);
  }
  if (named.name === "PreviewRendererError") {
    return mapRenderer(named.code as PreviewRendererError["code"]);
  }

  return { code: "unknown", message: MESSAGES.unknown };
}

function mapFetch(code: ScrapeFetchError["code"]): PublicError {
  switch (code) {
    case "invalid_url":
      return publicErr("invalid_url");
    case "not_https":
      return publicErr("not_https");
    case "private_address":
      // Don't tell the attacker we matched a private-address rule —
      // collapses to a generic "blocked." Server logs still have the
      // raw reason for debug.
      return publicErr("site_blocked");
    case "timeout":
    case "network":
      return publicErr("site_unreachable");
    case "too_large":
      return publicErr("site_too_large");
    case "bad_content_type":
      return publicErr("site_not_html");
    case "too_many_redirects":
    case "http_error":
      return publicErr("site_returned_error");
    default:
      return publicErr("unknown");
  }
}

function mapAgent(code: ScrapeAgentError["code"]): PublicError {
  switch (code) {
    case "fetch_failed":
      return publicErr("site_unreachable");
    case "extract_failed":
      return publicErr("site_not_html");
    case "content_pass_failed":
    case "content_pass_empty":
    case "design_pass_failed":
    case "design_parse_failed":
      return publicErr("ai_failed");
    default:
      return publicErr("unknown");
  }
}

function mapRenderer(code: PreviewRendererError["code"]): PublicError {
  switch (code) {
    case "anthropic_failed":
      return publicErr("ai_failed");
    case "no_html_block":
      return publicErr("render_failed");
    default:
      return publicErr("unknown");
  }
}

function publicErr(code: PublicErrorCode): PublicError {
  return { code, message: MESSAGES[code] };
}

/**
 * Serialize a PublicError for persistence on `anonymous_previews.error`.
 * Encodes the code + message together so the action layer can re-parse.
 */
export function serializePublicError(p: PublicError): string {
  return `${p.code}|${p.message}`;
}

/**
 * Inverse of serializePublicError. Tolerant — old rows that pre-date this
 * format still produce a usable PublicError with code='unknown'.
 */
export function parsePublicError(stored: string): PublicError {
  const sep = stored.indexOf("|");
  if (sep === -1) return { code: "unknown", message: stored || MESSAGES.unknown };
  const code = stored.slice(0, sep) as PublicErrorCode;
  const message = stored.slice(sep + 1);
  if (!(code in MESSAGES)) return { code: "unknown", message: MESSAGES.unknown };
  return { code, message };
}
