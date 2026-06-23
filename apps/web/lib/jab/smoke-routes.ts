/**
 * smoke-routes.ts — minimal deployed-route checker. Pure (fetch injected)
 * so the script wrapper stays untested glue. 2xx/3xx = ok (Next 308s
 * trailing slashes; the followed-redirect end status is what matters).
 */
export interface RouteCheckResult {
  path: string;
  status: number | null;
  ok: boolean;
  error?: string;
}

export interface CheckRoutesOptions {
  /** Per-request abort timeout. Default 30s (operator runbook). The verify gate
   * passes a much shorter value so a slow/cold preview can't blow the step. */
  timeoutMs?: number;
  /** Max in-flight requests. Default 1 (sequential, byte-identical to before).
   * The verify gate raises this so up-to-N reachability probes stay bounded in
   * wall-clock. Output order ALWAYS matches input order regardless. */
  concurrency?: number;
}

export async function checkRoutes(
  baseUrl: string,
  paths: string[],
  fetchImpl: typeof fetch = fetch,
  opts: CheckRoutesOptions = {},
): Promise<RouteCheckResult[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const concurrency = Math.max(1, opts.concurrency ?? 1);

  const checkOne = async (p: string): Promise<RouteCheckResult> => {
    const path = p.startsWith("/") ? p : `/${p}`;
    try {
      // A cold-starting / protected preview must FAIL the check, not hang.
      const res = await fetchImpl(`${base}${path}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { path, status: res.status, ok: res.status >= 200 && res.status < 400 };
    } catch (err) {
      return {
        path,
        status: null,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  // Index-keyed worker pool: results are written into their input slot, so the
  // returned array preserves input order independent of completion order.
  const results: RouteCheckResult[] = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const i = next++;
      results[i] = await checkOne(paths[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return results;
}
