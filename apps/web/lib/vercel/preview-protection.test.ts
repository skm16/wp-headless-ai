// apps/web/lib/vercel/preview-protection.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertPreviewReachable,
  PreviewProtectedError,
} from "./preview-protection";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("assertPreviewReachable", () => {
  it("resolves (no throw) on a 200 response", async () => {
    stubFetch(async () => new Response(null, { status: 200 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).resolves.toBeUndefined();
  });

  it("resolves on a 3xx redirect (preview reachable, just redirecting)", async () => {
    stubFetch(async () => new Response(null, { status: 302 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).resolves.toBeUndefined();
  });

  it("throws PreviewProtectedError on 401", async () => {
    stubFetch(async () => new Response(null, { status: 401 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).rejects.toBeInstanceOf(
      PreviewProtectedError,
    );
  });

  it("throws PreviewProtectedError on 403", async () => {
    stubFetch(async () => new Response(null, { status: 403 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).rejects.toBeInstanceOf(
      PreviewProtectedError,
    );
  });

  it("the PreviewProtectedError carries the url and a helpful message", async () => {
    stubFetch(async () => new Response(null, { status: 401 }));
    try {
      await assertPreviewReachable("https://x.vercel.app");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PreviewProtectedError);
      const err = e as PreviewProtectedError;
      expect(err.url).toBe("https://x.vercel.app");
      expect(err.message).toMatch(/Deployment Protection/i);
    }
  });

  it("swallows a network error (returns reachable=unknown -> no throw)", async () => {
    // A transient network failure must NOT be reported as protection — only
    // an explicit 401/403 counts. We resolve quietly.
    stubFetch(async () => {
      throw new TypeError("network down");
    });
    await expect(assertPreviewReachable("https://x.vercel.app")).resolves.toBeUndefined();
  });

  it("does not throw on other 4xx (e.g. 404) — only 401/403 are protection", async () => {
    stubFetch(async () => new Response(null, { status: 404 }));
    await expect(assertPreviewReachable("https://x.vercel.app")).resolves.toBeUndefined();
  });
});
