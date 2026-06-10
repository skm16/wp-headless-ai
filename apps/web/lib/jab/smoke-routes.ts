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

export async function checkRoutes(
  baseUrl: string,
  paths: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<RouteCheckResult[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const results: RouteCheckResult[] = [];
  for (const p of paths) {
    const path = p.startsWith("/") ? p : `/${p}`;
    try {
      const res = await fetchImpl(`${base}${path}`, { redirect: "follow" });
      results.push({ path, status: res.status, ok: res.status >= 200 && res.status < 400 });
    } catch (err) {
      results.push({
        path,
        status: null,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
