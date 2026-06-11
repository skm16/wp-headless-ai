import { describe, it, expect, vi } from "vitest";
import { OPEN_EDIT_STATUSES, hasOpenWorkspaceEdit } from "./open-edits";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Chainable fake: .from("workspace_edits").select(..., {count,head}).eq(...).in(...) */
function fakeClient(result: { count: number | null; error: { message: string } | null }) {
  const inFn = vi.fn().mockResolvedValue(result);
  const eqFn = vi.fn(() => ({ in: inFn }));
  const selectFn = vi.fn(() => ({ eq: eqFn }));
  const fromFn = vi.fn(() => ({ select: selectFn }));
  return { client: { from: fromFn } as unknown as SupabaseClient, fromFn, selectFn, eqFn, inFn };
}

describe("OPEN_EDIT_STATUSES", () => {
  it("is exactly queued + running — completed=dispatched (linked build covers it), failed/discarded=terminal", () => {
    expect([...OPEN_EDIT_STATUSES]).toEqual(["queued", "running"]);
  });
});

describe("hasOpenWorkspaceEdit", () => {
  it("returns true when at least one open edit exists", async () => {
    const { client, fromFn, selectFn, eqFn, inFn } = fakeClient({ count: 2, error: null });
    await expect(hasOpenWorkspaceEdit(client, "proj-1")).resolves.toBe(true);
    expect(fromFn).toHaveBeenCalledWith("workspace_edits");
    // head-count query — no row payload crosses the wire on a 5s poll
    expect(selectFn).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(eqFn).toHaveBeenCalledWith("project_id", "proj-1");
    expect(inFn).toHaveBeenCalledWith("status", ["queued", "running"]);
  });

  it("returns false when count is 0", async () => {
    const { client } = fakeClient({ count: 0, error: null });
    await expect(hasOpenWorkspaceEdit(client, "proj-1")).resolves.toBe(false);
  });

  it("returns false when count is null", async () => {
    const { client } = fakeClient({ count: null, error: null });
    await expect(hasOpenWorkspaceEdit(client, "proj-1")).resolves.toBe(false);
  });

  it("fails soft (false) on a query error — polling just stops early, never throws to the pane", async () => {
    const { client } = fakeClient({ count: null, error: { message: "boom" } });
    await expect(hasOpenWorkspaceEdit(client, "proj-1")).resolves.toBe(false);
  });
});
