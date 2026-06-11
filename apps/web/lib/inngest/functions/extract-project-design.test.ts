import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Capture the Inngest function config + handler ──────────────────────────
const { createFunctionMock, captured } = vi.hoisted(() => {
  const captured: {
    config?: Record<string, unknown>;
    trigger?: Record<string, unknown>;
    handler?: (ctx: unknown) => Promise<unknown>;
  } = {};
  const createFunctionMock = vi.fn(
    (
      config: Record<string, unknown>,
      trigger: Record<string, unknown>,
      handler: (ctx: unknown) => Promise<unknown>,
    ) => {
      captured.config = config;
      captured.trigger = trigger;
      captured.handler = handler;
      return { config, trigger, handler };
    },
  );
  return { createFunctionMock, captured };
});
vi.mock("@/lib/inngest/client", () => ({
  inngest: { createFunction: createFunctionMock },
}));

// ── Scrape result fixture ───────────────────────────────────────────────────
const { scrapeUsageFixture, runDesignTokenScrapeMock } = vi.hoisted(() => {
  const scrapeUsageFixture = {
    primary: { model: "claude-haiku-4-5-20251001", inputTokens: 900, outputTokens: 410 },
    fallback: { model: "claude-sonnet-4-6", inputTokens: 905, outputTokens: 432 },
    fallbackUsed: true,
    at: "2026-06-10T12:00:00.000Z",
  };
  const runDesignTokenScrapeMock = vi.fn(async () => ({
    url: "https://example.com/",
    fetchedAt: "2026-06-10T12:00:00.000Z",
    byteSize: 4096,
    extract: { faviconUrl: null, socialImage: null },
    design: {
      colors: {
        primary: { value: "#112233", confidence: 0.85, reasoning: "rank 1" },
        secondary: { value: null, confidence: 0, reasoning: "none" },
        accent: { value: null, confidence: 0, reasoning: "none" },
      },
      logo: { src: null, confidence: 0, reasoning: "no <img> tags found on page" },
      typography: {
        heading: { value: "Playfair Display", confidence: 0.9, reasoning: "[0]" },
        body: { value: null, confidence: 0, reasoning: "no body samples" },
      },
      buttonPair: {
        primary: { value: "Book now", confidence: 0.8, reasoning: "[0]" },
        secondary: { value: null, confidence: 0, reasoning: "none" },
      },
      personality: {
        tone: { value: "warm", confidence: 0.6, reasoning: "copy register" },
        energy: { value: "medium", confidence: 0.6, reasoning: "copy register" },
        audience: { value: "homeowners", confidence: 0.5, reasoning: "headings" },
      },
    },
    scrapeUsage: scrapeUsageFixture,
  }));
  return { scrapeUsageFixture, runDesignTokenScrapeMock };
});
vi.mock("@/lib/ai/scrape-agent", () => ({
  runDesignTokenScrape: runDesignTokenScrapeMock,
}));

vi.mock("@/lib/ai/asset-capture", () => ({
  captureAssets: vi.fn(async () => ({
    logoPath: null,
    faviconPath: null,
    ogImagePath: null,
    failures: {},
  })),
}));

// ── Supabase admin stub: .update(payload).eq().eq().select() ───────────────
const { dbState, fromMock } = vi.hoisted(() => {
  const dbState: { updatePayload: Record<string, unknown> | null } = { updatePayload: null };
  const fromMock = vi.fn(() => ({
    update: (payload: Record<string, unknown>) => {
      dbState.updatePayload = payload;
      return {
        eq: () => ({
          eq: () => ({
            select: async () => ({ data: [{ id: "p1" }], error: null }),
          }),
        }),
      };
    },
  }));
  return { dbState, fromMock };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

// Importing the module runs the (mocked) createFunction registration.
import "@/lib/inngest/functions/extract-project-design";

function makeStep() {
  return {
    run: async <T>(_name: string, f: () => Promise<T> | T): Promise<T> => f(),
  };
}

describe("extractProjectDesign worker", () => {
  beforeEach(() => {
    dbState.updatePayload = null;
  });

  it("persists design_scrape_usage from the scrape result, alongside design_tokens + personality", async () => {
    await captured.handler!({
      event: { data: { projectId: "p1", tenantId: "t1", wpUrl: "https://example.com" } },
      step: makeStep(),
    });

    expect(dbState.updatePayload).not.toBeNull();
    expect(dbState.updatePayload!.design_scrape_usage).toEqual(scrapeUsageFixture);
    // Pre-existing split behavior unchanged: personality on its own column,
    // the rest in design_tokens; no asset paths when capture returned nulls.
    expect(dbState.updatePayload!).toHaveProperty("design_tokens");
    expect(dbState.updatePayload!).toHaveProperty("personality");
    expect(dbState.updatePayload!).not.toHaveProperty("logo_storage_path");
    expect(Object.keys(dbState.updatePayload!).sort()).toEqual(
      ["design_scrape_usage", "design_tokens", "personality"],
    );
  });
});
