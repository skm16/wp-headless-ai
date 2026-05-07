/**
 * Auto-relax TLS verification for local-development WordPress installs.
 *
 * LocalWP, Valet, DDEV and similar tools serve sites under `.local` or
 * `.test` TLDs with self-signed certs that don't validate against the
 * system trust store. Asking users to remember
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` for every CLI invocation is a wart;
 * the CLI knows it's talking to local dev when the hostname tells it,
 * so it should just relax the check itself and print one warning.
 *
 * For non-`.local`/`.test` hosts that still need relaxed TLS (private
 * CA on staging, etc.), the explicit `--insecure` flag flips the same
 * switch with the user opting in by name.
 *
 * Implementation note: Node's `fetch` (undici) reads
 * `NODE_TLS_REJECT_UNAUTHORIZED` once when constructing its default
 * dispatcher. Setting `process.env.NODE_TLS_REJECT_UNAUTHORIZED` before
 * the first fetch is enough — short-lived CLI process, no leak risk.
 */

const LOCAL_DEV_TLDS = [".local", ".test"];

let warnedOnce = false;

/**
 * Inspect a WP URL and decide whether to disable TLS verification for the
 * remainder of this CLI process.
 *
 * Returns true if relaxation was applied (either auto-detected or via
 * `insecure: true`); the caller can use it for messaging if needed.
 */
export function relaxTlsForLocalDev(wpUrl: string, opts: { insecure?: boolean } = {}): boolean {
  const hostname = parseHostname(wpUrl);
  const isLocalTld = hostname !== null && LOCAL_DEV_TLDS.some((tld) => hostname.endsWith(tld));
  const shouldRelax = isLocalTld || opts.insecure === true;

  if (!shouldRelax) return false;

  // Already relaxed via env (e.g. user invoked with NODE_TLS_REJECT_UNAUTHORIZED=0
  // before we ran). Don't print our warning again.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    return true;
  }

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  if (!warnedOnce) {
    const reason = opts.insecure === true && !isLocalTld
      ? "--insecure flag was passed"
      : `host is on a local-dev TLD (${LOCAL_DEV_TLDS.join(", ")})`;
    console.warn(`⚠ TLS verification disabled for this run — ${reason}.`);
    warnedOnce = true;
  }
  return true;
}

function parseHostname(wpUrl: string): string | null {
  try {
    return new URL(wpUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}
