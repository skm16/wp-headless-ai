import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/admin";
import {
  formatErrorText,
  markBuildFailed,
  cascadeWorkspaceEditFailure,
} from "./shared-failure";

type CascadeClient = Parameters<typeof cascadeWorkspaceEditFailure>[0];

describe("formatErrorText", () => {
  it("returns the message of an Error", () => {
    expect(formatErrorText(new Error("boom"))).toBe("boom");
  });

  it("returns strings as-is", () => {
    expect(formatErrorText("plain string")).toBe("plain string");
  });

  it("JSON-stringifies plain objects", () => {
    expect(formatErrorText({ code: 500, msg: "x" })).toBe('{"code":500,"msg":"x"}');
  });

  it("falls back to String(err) on circular structures", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(formatErrorText(obj)).toMatch(/object/i);
  });
});

/**
 * A call-recording admin-client mock. Each `from(table)` records the
 * table, the update payload, and every `.eq()` filter; the returned
 * builder is thenable so `await supabase.from(..).update(..).eq(..).eq(..)`
 * resolves to `{ error: null }`.
 */
interface RecordedCall {
  table: string;
  updates?: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function makeRecordingAdmin() {
  const calls: RecordedCall[] = [];
  const client = {
    from(table: string) {
      const record: RecordedCall = { table, filters: {} };
      calls.push(record);
      const builder = {
        update(vals: Record<string, unknown>) {
          record.updates = vals;
          return builder;
        },
        eq(col: string, val: unknown) {
          record.filters[col] = val;
          return builder;
        },
        then(resolve: (v: { error: null }) => void) {
          resolve({ error: null });
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

describe("markBuildFailed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates site_builds to failed with the build + project filters", async () => {
    const { client, calls } = makeRecordingAdmin();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

    await markBuildFailed({
      buildId: "b1",
      projectId: "p1",
      phase: "verifying",
      error: new Error("kaboom"),
    });

    const buildCall = calls.find((c) => c.table === "site_builds");
    expect(buildCall).toBeDefined();
    expect(buildCall!.updates).toMatchObject({
      status: "failed",
      failed_phase: "verifying",
      error_text: "kaboom",
    });
    expect(buildCall!.filters).toMatchObject({ id: "b1", project_id: "p1" });
  });

  it("F5: also cascades to the workspace_edits row by result_build_id, only while running", async () => {
    const { client, calls } = makeRecordingAdmin();
    (createAdminClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

    await markBuildFailed({
      buildId: "b1",
      projectId: "p1",
      phase: "composing",
      error: new Error("kaboom"),
    });

    const editCall = calls.find((c) => c.table === "workspace_edits");
    expect(editCall).toBeDefined();
    expect(editCall!.updates).toMatchObject({
      status: "failed",
      error_text: "kaboom",
    });
    // Cascade is keyed on the RESULT build id and gated on status='running'
    // so it's a no-op for non-edit builds and idempotent on replay.
    expect(editCall!.filters).toMatchObject({
      result_build_id: "b1",
      status: "running",
    });
  });
});

describe("cascadeWorkspaceEditFailure", () => {
  it("updates workspace_edits to failed, keyed on result_build_id + status=running", async () => {
    const record: { table: string; updates?: Record<string, unknown>; filters: Record<string, unknown> } = {
      table: "",
      filters: {},
    };
    const builder = {
      update(v: Record<string, unknown>) {
        record.updates = v;
        return builder;
      },
      eq(col: string, val: unknown) {
        record.filters[col] = val;
        return builder;
      },
      then(resolve: (v: { error: null }) => void) {
        resolve({ error: null });
      },
    };
    const supabase = {
      from(t: string) {
        record.table = t;
        return builder;
      },
    } as unknown as CascadeClient;

    await cascadeWorkspaceEditFailure(supabase, "b1", "boom");

    expect(record.table).toBe("workspace_edits");
    expect(record.updates).toMatchObject({ status: "failed", error_text: "boom" });
    expect(record.filters).toMatchObject({ result_build_id: "b1", status: "running" });
  });

  it("swallows a supabase error (does not throw — callers are on a failure path)", async () => {
    const builder = {
      update() {
        return builder;
      },
      eq() {
        return builder;
      },
      then(resolve: (v: { error: { message: string } }) => void) {
        resolve({ error: { message: "db down" } });
      },
    };
    const supabase = {
      from() {
        return builder;
      },
    } as unknown as CascadeClient;

    await expect(
      cascadeWorkspaceEditFailure(supabase, "b1", "boom"),
    ).resolves.toBeUndefined();
  });
});
