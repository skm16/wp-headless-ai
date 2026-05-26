import "server-only";

/**
 * Public-facing error shape for the design-token scrape pipeline.
 *
 * The pipeline throws richly-typed errors with discriminated `code` fields
 * (`ScrapeFetchError.code`, `ScrapeAgentError.code`). Persisting those raw
 * `.message` strings to consumer rows — then echoing them back to the user
 * — leaks internal detail (resolved IPs, Anthropic stack traces, hostnames).
 *
 * This module defines the safe public shape (`PublicError` + `MESSAGES`)
 * and the (de)serialization helpers used to round-trip a PublicError
 * through a consumer row's `error` column.
 *
 * The internal raw message is still logged server-side via the worker's
 * step.run() so we don't lose debug context.
 *
 * Copy aligns with `docs/saas-failure-states.md` where applicable.
 *
 * Stage 0 v2: dropped the `toPublicError` mapper (its only caller was the
 * removed preview-renderer pipeline) along with the `PreviewRendererError`
 * arm and the dead `content_pass_failed` / `content_pass_empty` agent arms
 * (removed from the union when the two-pass content scrape was collapsed
 * to a single design pass).
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
  unknown:
    "Something went wrong generating your preview. Try again, or contact us if it keeps happening.",
};

/**
 * Serialize a PublicError for persistence on a consumer row's `error`
 * column. Encodes the code + message together so the action layer can
 * re-parse.
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
