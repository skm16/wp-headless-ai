// apps/web/lib/jab/playwright-discovery.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PageDescriptor } from "./discovery-types";

// We mock playwright at the boundary so unit tests don't need a real browser.
// The real-browser smoke runs via scripts/smoke-discover-site.ts (Task 22).
//
// NOTE: vi.mock() is hoisted to the top of the file by vitest, so factory
// functions cannot close over module-level consts declared with `const` (TDZ).
// We use vi.hoisted() so the mock objects are initialised before the hoisted
// vi.mock() factories run — this is the vitest-canonical fix for this pattern.
const { mockPage, mockContext, mockBrowser, mockChromiumLaunch } = vi.hoisted(() => {
  const mockPage = {
    goto: vi.fn(),
    setViewportSize: vi.fn(),
    screenshot: vi.fn(),
    evaluate: vi.fn(),
    close: vi.fn(),
  };
  const mockContext = { newPage: vi.fn().mockResolvedValue(mockPage), close: vi.fn() };
  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn(),
  };
  const mockChromiumLaunch = vi.fn().mockResolvedValue(mockBrowser);
  return { mockPage, mockContext, mockBrowser, mockChromiumLaunch };
});

vi.mock("playwright", () => ({
  chromium: {
    launch: mockChromiumLaunch,
  },
}));

// Mock storage upload to a no-op that returns a fake path.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        upload: vi.fn().mockResolvedValue({ data: { path: "ok" }, error: null }),
      }),
    },
  }),
}));

import { capturePage } from "./playwright-discovery";

beforeEach(() => {
  vi.clearAllMocks();
  mockPage.screenshot.mockResolvedValue(Buffer.from([0, 1, 2, 3]));
  mockPage.evaluate.mockResolvedValue([]); // no block instances captured in this test
  // Re-wire after restoreAllMocks/clearAllMocks resets the resolved values on all mocks.
  // mockChromiumLaunch must be re-wired here because vi.restoreAllMocks() (afterEach) calls
  // mockRestore() on every vi.fn(), which resets their implementation to undefined.
  mockChromiumLaunch.mockResolvedValue(mockBrowser);
  mockPage.close.mockResolvedValue(undefined);
  mockPage.goto.mockResolvedValue(undefined);
  mockContext.newPage.mockResolvedValue(mockPage);
  mockContext.close.mockResolvedValue(undefined);
  mockBrowser.newContext.mockResolvedValue(mockContext);
  mockBrowser.close.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("capturePage — navigation + screenshot", () => {
  it("captures screenshots at all three viewports and returns storage paths", async () => {
    const page: PageDescriptor = { slug: "home", post_type: "page", url: "https://wp.example.com/" };
    const result = await capturePage({
      page,
      buildId: "b1",
      projectId: "p1",
      tenantId: "t1",
    });
    expect(result.slug).toBe("home");
    expect(Object.keys(result.screenshotPaths).sort()).toEqual(["1280", "375", "768"]);
    expect(mockPage.screenshot).toHaveBeenCalledTimes(3);
  });

  it("records a failure entry when navigation throws but does not throw", async () => {
    mockPage.goto.mockRejectedValueOnce(new Error("nav timeout"));
    const page: PageDescriptor = { slug: "broken", post_type: "page", url: "https://wp.example.com/broken" };
    const result = await capturePage({
      page,
      buildId: "b1",
      projectId: "p1",
      tenantId: "t1",
    });
    expect(result.failures).toBeDefined();
    expect(result.failures!.length).toBeGreaterThan(0);
  });
});

describe("capturePage — block instance mapping", () => {
  it("returns block instances from page.evaluate output", async () => {
    mockPage.evaluate.mockResolvedValue([
      {
        blockName: "core/heading",
        boundingRect: { x: 0, y: 0, width: 800, height: 60 },
        computedStyles: {},
      },
      {
        blockName: "core/paragraph",
        boundingRect: { x: 0, y: 80, width: 800, height: 240 },
        computedStyles: {},
      },
    ]);
    const result = await capturePage({
      page: { slug: "home", post_type: "page", url: "https://wp.example.com/" },
      buildId: "b1",
      projectId: "p1",
      tenantId: "t1",
    });
    const captures = result.blockCapturesByViewport["1280"];
    expect(captures).toHaveLength(2);
    expect(captures[0].blockName).toBe("core/heading");
    expect(captures[1].boundingRect.height).toBe(240);
  });
});
