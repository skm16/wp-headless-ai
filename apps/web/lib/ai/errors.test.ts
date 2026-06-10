import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { classifyAiError, isRetryableAiFailure, type AiFailureKind } from "./errors";

/**
 * Build an `instanceof`-true instance WITHOUT invoking the SDK error
 * constructor (its signature varies across SDK versions; prototype
 * injection is stable across all of them).
 */
function fakeInstance<T extends abstract new (...args: never[]) => unknown>(cls: T): InstanceType<T> {
  return Object.create(cls.prototype) as InstanceType<T>;
}

describe("classifyAiError", () => {
  it("classifies RateLimitError as rate_limit", () => {
    expect(classifyAiError(fakeInstance(Anthropic.RateLimitError))).toBe("rate_limit");
  });

  it("classifies OverloadedError (529) as overloaded", () => {
    // Anthropic.OverloadedError is a type-only interface in SDK 0.95.1 (not an error
    // class). The plan's documented fallback: use a raw APIError with status=529.
    const overloaded529 = Object.create(Anthropic.APIError.prototype) as InstanceType<typeof Anthropic.APIError>;
    (overloaded529 as unknown as { status: number }).status = 529;
    expect(classifyAiError(overloaded529)).toBe("overloaded");
  });

  it("classifies AuthenticationError and PermissionDeniedError as auth", () => {
    expect(classifyAiError(fakeInstance(Anthropic.AuthenticationError))).toBe("auth");
    expect(classifyAiError(fakeInstance(Anthropic.PermissionDeniedError))).toBe("auth");
  });

  it("classifies BadRequestError as bad_request", () => {
    expect(classifyAiError(fakeInstance(Anthropic.BadRequestError))).toBe("bad_request");
  });

  it("classifies APIConnectionError as connection", () => {
    expect(classifyAiError(fakeInstance(Anthropic.APIConnectionError))).toBe("connection");
  });

  it("classifies InternalServerError as server_error", () => {
    expect(classifyAiError(fakeInstance(Anthropic.InternalServerError))).toBe("server_error");
  });

  it("classifies a bare APIError as unknown", () => {
    expect(classifyAiError(fakeInstance(Anthropic.APIError))).toBe("unknown");
  });

  it("classifies non-Anthropic values as unknown", () => {
    expect(classifyAiError(new Error("boom"))).toBe("unknown");
    expect(classifyAiError("string error")).toBe("unknown");
    expect(classifyAiError(undefined)).toBe("unknown");
    expect(classifyAiError(null)).toBe("unknown");
  });
});

describe("isRetryableAiFailure", () => {
  it("marks rate_limit / overloaded / server_error / connection retryable", () => {
    const retryable: AiFailureKind[] = ["rate_limit", "overloaded", "server_error", "connection"];
    for (const kind of retryable) expect(isRetryableAiFailure(kind)).toBe(true);
  });

  it("marks bad_request / auth / unknown NOT retryable", () => {
    const fatal: AiFailureKind[] = ["bad_request", "auth", "unknown"];
    for (const kind of fatal) expect(isRetryableAiFailure(kind)).toBe(false);
  });
});
