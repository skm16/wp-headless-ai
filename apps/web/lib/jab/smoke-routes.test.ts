import { describe, expect, it } from "vitest";
import { checkRoutes } from "./smoke-routes";

const fakeFetch = (statusByPath: Record<string, number>) =>
  (async (url: RequestInfo | URL) => {
    const path = new URL(String(url)).pathname;
    const status = statusByPath[path];
    if (status === undefined) throw new Error("connection refused");
    return { status } as Response;
  }) as typeof fetch;

describe("checkRoutes", () => {
  it("marks 2xx/3xx ok and 4xx/5xx + network errors failed", async () => {
    const results = await checkRoutes(
      "https://preview.example.com/",
      ["/", "beer/lil-heaven", "/missing", "/down"],
      fakeFetch({ "/": 200, "/beer/lil-heaven": 200, "/missing": 404 }),
    );
    expect(results).toEqual([
      { path: "/", status: 200, ok: true },
      { path: "/beer/lil-heaven", status: 200, ok: true },
      { path: "/missing", status: 404, ok: false },
      { path: "/down", status: null, ok: false, error: "connection refused" },
    ]);
  });

  it("preserves input order even when run with concurrency > 1", async () => {
    // Resolve later-listed paths faster than earlier ones; output must still
    // follow input order, not completion order.
    const delayed = (statusByPath: Record<string, number>, delayByPath: Record<string, number>) =>
      (async (url: RequestInfo | URL) => {
        const path = new URL(String(url)).pathname;
        await new Promise((r) => setTimeout(r, delayByPath[path] ?? 0));
        return { status: statusByPath[path] } as Response;
      }) as typeof fetch;
    const results = await checkRoutes(
      "https://preview.example.com",
      ["/a", "/b", "/c"],
      delayed({ "/a": 200, "/b": 404, "/c": 500 }, { "/a": 30, "/b": 5, "/c": 0 }),
      { concurrency: 3 },
    );
    expect(results.map((r) => r.path)).toEqual(["/a", "/b", "/c"]);
    expect(results.map((r) => r.status)).toEqual([200, 404, 500]);
  });
});
