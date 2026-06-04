import { describe, it, expect, vi } from "vitest";
import { isBuildCancelled } from "./build-cancel";

function fakeSupabase(status: string | null, error: unknown = null) {
  const chain = {
    from: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({ data: status === null ? null : { status }, error })),
  };
  return chain as unknown as Parameters<typeof isBuildCancelled>[0];
}

describe("isBuildCancelled", () => {
  it("true when the build row status is 'cancelled'", async () => {
    expect(await isBuildCancelled(fakeSupabase("cancelled"), "b", "p")).toBe(true);
  });
  it("false for any non-cancelled status", async () => {
    expect(await isBuildCancelled(fakeSupabase("composing"), "b", "p")).toBe(false);
    expect(await isBuildCancelled(fakeSupabase("ready"), "b", "p")).toBe(false);
  });
  it("false (fail-open) when the row is missing or the query errors", async () => {
    expect(await isBuildCancelled(fakeSupabase(null), "b", "p")).toBe(false);
    expect(await isBuildCancelled(fakeSupabase("cancelled", { message: "boom" }), "b", "p")).toBe(false);
  });
});
