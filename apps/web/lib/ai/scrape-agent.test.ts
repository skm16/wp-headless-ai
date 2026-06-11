import { describe, it, expect, vi, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { ZodError } from "zod";

// ---------------------------------------------------------------------------
// Module mocks (shared by all suites in this file).
//
// scrape-agent imports `getAnthropicClient` from "./client" and
// `fetchHtmlSafely`/`ScrapeFetchError` from "./scrape-fetch". Both are
// mocked so no network/API key is ever touched. `extractFromHtml`,
// `pickColors`, `pickLogo`, Zod validation, and the fallback orchestration
// all run REAL.
// ---------------------------------------------------------------------------

const { messagesCreate } = vi.hoisted(() => ({ messagesCreate: vi.fn() }));

vi.mock("./client", () => ({
  getAnthropicClient: () => ({ messages: { create: messagesCreate } }),
}));

vi.mock("./scrape-fetch", () => {
  class ScrapeFetchError extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly cause?: unknown,
    ) {
      super(message);
      this.name = "ScrapeFetchError";
    }
  }
  return {
    ScrapeFetchError,
    fetchHtmlSafely: vi.fn(async () => ({
      finalUrl: "https://example.com/",
      html: `<html><head><title>Example Co</title></head><body><h1>Hello</h1><a class="btn" href="/book">Book now</a></body></html>`,
      contentType: "text/html",
      byteSize: 123,
    })),
  };
});

import {
  DESIGN_JSON_SCHEMA,
  runDesignTokenScrape,
  ScrapeAgentError,
} from "./scrape-agent";

beforeEach(() => {
  delete process.env.JAB_AI_MODEL;
  delete process.env.JAB_AI_MODEL_DESIGN;
  messagesCreate.mockReset();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A response payload that passes LlmDesignSubsetSchema. */
const VALID_SUBSET = {
  typography: {
    heading: { value: "Playfair Display", confidence: 0.9, reasoning: "heading samples [0]" },
    body: { value: null, confidence: 0, reasoning: "no body samples" },
  },
  buttonPair: {
    primary: { value: "Book now", confidence: 0.8, reasoning: "header CTA [0]" },
    secondary: { value: null, confidence: 0, reasoning: "no second CTA" },
  },
  personality: {
    tone: { value: "playful", confidence: 0.6, reasoning: "casual heading copy" },
    energy: { value: "high", confidence: 0.6, reasoning: "exclamatory copy" },
    audience: { value: "local customers", confidence: 0.5, reasoning: "headings" },
  },
};

/** Builds a minimal Anthropic Messages response. */
function apiResponse(
  text: string,
  overrides: { stop_reason?: string; input_tokens?: number; output_tokens?: number } = {},
) {
  return {
    content: [{ type: "text", text }],
    stop_reason: overrides.stop_reason ?? "end_turn",
    usage: {
      input_tokens: overrides.input_tokens ?? 900,
      output_tokens: overrides.output_tokens ?? 400,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/** Walks every plain-object node in a JSON schema. */
function walkSchema(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walkSchema(n, visit);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    visit(obj);
    for (const v of Object.values(obj)) walkSchema(v, visit);
  }
}

/** Path-based accessor for schema nodes in assertions. */
function at(obj: unknown, path: string[]): unknown {
  return path.reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], obj);
}

// ---------------------------------------------------------------------------
// Task 1 — wire schema invariants
// ---------------------------------------------------------------------------

describe("DESIGN_JSON_SCHEMA", () => {
  it("requires typography, buttonPair, personality at the top level", () => {
    expect(at(DESIGN_JSON_SCHEMA, ["type"])).toBe("object");
    expect([...(at(DESIGN_JSON_SCHEMA, ["required"]) as string[])].sort()).toEqual(
      ["buttonPair", "personality", "typography"],
    );
  });

  it("sets additionalProperties:false and exhaustive required on EVERY object node", () => {
    let objectNodes = 0;
    walkSchema(DESIGN_JSON_SCHEMA, (obj) => {
      if (obj.type === "object" && obj.properties) {
        objectNodes += 1;
        expect(obj.additionalProperties).toBe(false);
        expect([...(obj.required as string[])].sort()).toEqual(
          Object.keys(obj.properties as Record<string, unknown>).sort(),
        );
      }
    });
    // 1 root + 3 groups + 7 confidence-field objects
    expect(objectNodes).toBe(11);
  });

  it("contains NO numeric/length constraints (unsupported by structured outputs)", () => {
    const banned = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength"];
    walkSchema(DESIGN_JSON_SCHEMA, (obj) => {
      for (const key of banned) {
        expect(obj, `schema node must not carry "${key}"`).not.toHaveProperty(key);
      }
    });
  });

  it("pins the energy value to the low/medium/high enum", () => {
    expect(
      at(DESIGN_JSON_SCHEMA, [
        "properties", "personality", "properties", "energy", "properties", "value", "enum",
      ]),
    ).toEqual(["low", "medium", "high"]);
  });

  it("models nullable values as type [string, null]", () => {
    expect(
      at(DESIGN_JSON_SCHEMA, [
        "properties", "typography", "properties", "heading", "properties", "value", "type",
      ]),
    ).toEqual(["string", "null"]);
    expect(
      at(DESIGN_JSON_SCHEMA, [
        "properties", "buttonPair", "properties", "secondary", "properties", "value", "type",
      ]),
    ).toEqual(["string", "null"]);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — structured-outputs call path
// ---------------------------------------------------------------------------

describe("runDesignPassOnce via runDesignTokenScrape — structured outputs", () => {
  it("sends output_config json_schema and parses the bare-JSON response", async () => {
    messagesCreate.mockResolvedValueOnce(apiResponse(JSON.stringify(VALID_SUBSET)));

    const result = await runDesignTokenScrape({ url: "https://example.com" });

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const params = messagesCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.model).toBe("claude-haiku-4-5-20251001"); // design default
    expect(params.max_tokens).toBe(4096);
    expect(params.output_config).toEqual({
      format: { type: "json_schema", schema: DESIGN_JSON_SCHEMA },
    });
    // The LLM subset lands merged with deterministic colors/logo.
    expect(result.design.typography.heading.value).toBe("Playfair Display");
    expect(result.design.personality.energy.value).toBe("high");
    expect(result.design.colors.primary).toBeDefined(); // deterministic, not from the LLM
  });

  it("no longer requires a ```json fenced block in the system prompt", async () => {
    messagesCreate.mockResolvedValueOnce(apiResponse(JSON.stringify(VALID_SUBSET)));
    await runDesignTokenScrape({ url: "https://example.com" });
    const params = messagesCreate.mock.calls[0]![0] as { system: string };
    expect(params.system).not.toContain("```json");
  });

  it("classifies malformed JSON (e.g. max_tokens truncation) as design_parse_failed", async () => {
    // Pin the design task to the fallback model so the fallback guard
    // (primary !== FALLBACK_MODEL) suppresses the second call and the
    // classification surfaces directly.
    process.env.JAB_AI_MODEL_DESIGN = "claude-sonnet-4-6";
    messagesCreate.mockResolvedValueOnce(
      apiResponse('{"typography": {"heading": {"valu', { stop_reason: "max_tokens" }),
    );

    await expect(runDesignTokenScrape({ url: "https://example.com" })).rejects.toMatchObject({
      name: "ScrapeAgentError",
      code: "design_parse_failed",
      cause: expect.any(SyntaxError),
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });

  it("classifies a Zod miss (constraints the wire schema can't express) as design_parse_failed", async () => {
    process.env.JAB_AI_MODEL_DESIGN = "claude-sonnet-4-6";
    // confidence 2 violates z.number().max(1) — valid per wire schema,
    // invalid per Zod.
    const bad = structuredClone(VALID_SUBSET);
    bad.typography.heading.confidence = 2;
    messagesCreate.mockResolvedValueOnce(apiResponse(JSON.stringify(bad)));

    await expect(runDesignTokenScrape({ url: "https://example.com" })).rejects.toMatchObject({
      name: "ScrapeAgentError",
      code: "design_parse_failed",
      cause: expect.any(ZodError),
    });
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});
