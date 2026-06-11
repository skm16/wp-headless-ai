import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mintDraftToken, verifyDraftToken, DRAFT_TOKEN_TTL_MS } from "./token";

const NOW = Date.parse("2026-06-10T12:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("JAB_DRAFT_TOKEN_SECRET", "test-secret-0123456789abcdef0123456789abcdef");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("draft token", () => {
  it("round-trips for the same project", () => {
    const token = mintDraftToken("proj-1", NOW);
    expect(verifyDraftToken("proj-1", token, NOW)).toBe(true);
  });

  it("rejects a token minted for another project", () => {
    const token = mintDraftToken("proj-1", NOW);
    expect(verifyDraftToken("proj-2", token, NOW)).toBe(false);
  });

  it("rejects after expiry (default TTL)", () => {
    const token = mintDraftToken("proj-1", NOW);
    expect(verifyDraftToken("proj-1", token, NOW + DRAFT_TOKEN_TTL_MS + 1)).toBe(false);
  });

  it("rejects malformed and empty tokens without throwing", () => {
    expect(verifyDraftToken("proj-1", null, NOW)).toBe(false);
    expect(verifyDraftToken("proj-1", "", NOW)).toBe(false);
    expect(verifyDraftToken("proj-1", "garbage", NOW)).toBe(false);
    expect(verifyDraftToken("proj-1", "123.nothex!", NOW)).toBe(false);
  });

  it("falls back to JAB_ENCRYPTION_KEY when JAB_DRAFT_TOKEN_SECRET is unset", () => {
    vi.stubEnv("JAB_DRAFT_TOKEN_SECRET", "");
    vi.stubEnv("JAB_ENCRYPTION_KEY", "fallback-key-0123456789abcdef");
    const token = mintDraftToken("proj-1", NOW);
    expect(verifyDraftToken("proj-1", token, NOW)).toBe(true);
  });

  it("throws loudly when no secret is configured (errors are loud)", () => {
    vi.stubEnv("JAB_DRAFT_TOKEN_SECRET", "");
    vi.stubEnv("JAB_ENCRYPTION_KEY", "");
    expect(() => mintDraftToken("proj-1", NOW)).toThrow(/JAB_DRAFT_TOKEN_SECRET/);
  });
});
