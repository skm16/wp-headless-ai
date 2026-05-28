import { describe, it, expect, vi } from "vitest";
import { decodeNextDynamicSegments, REQUIRED_DEPLOY_FILES, assertRequiredFiles } from "./download-project-tree";
import { downloadProjectTree } from "./download-project-tree";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("decodeNextDynamicSegments", () => {
  it("reverses catch-all encoding", () => {
    expect(decodeNextDynamicSegments("app/__catchall_slug__/page.tsx")).toBe(
      "app/[...slug]/page.tsx",
    );
  });
  it("reverses optional catch-all", () => {
    expect(decodeNextDynamicSegments("app/__optcatchall_path__/page.tsx")).toBe(
      "app/[[...path]]/page.tsx",
    );
  });
  it("reverses simple dynamic segments", () => {
    expect(decodeNextDynamicSegments("app/__dynamic_id__/page.tsx")).toBe(
      "app/[id]/page.tsx",
    );
  });
  it("handles paths with no encoded segments unchanged", () => {
    expect(decodeNextDynamicSegments("package.json")).toBe("package.json");
  });
});

describe("assertRequiredFiles", () => {
  it("returns silently when all required files present", () => {
    const paths = REQUIRED_DEPLOY_FILES.map((f) => f);
    expect(() => assertRequiredFiles(paths)).not.toThrow();
  });
  it("throws listing the specific missing files", () => {
    const paths = REQUIRED_DEPLOY_FILES.filter((f) => f !== "package.json");
    expect(() => assertRequiredFiles(paths)).toThrow(/package\.json/);
  });
});

describe("downloadProjectTree — recursive walk + decode", () => {
  it("flattens nested folders, decodes paths, downloads contents", async () => {
    // Fake Supabase storage: three list calls (root, app/, app/__catchall_slug__/),
    // plus three downloads.
    const listMock = vi
      .fn()
      // root level: package.json (file), app (folder)
      .mockImplementationOnce(async () => ({
        data: [
          {
            name: "package.json",
            id: "obj_pkg",
            metadata: { size: 100, mimetype: "text/plain" },
          },
          { name: "app", id: null, metadata: null },
        ],
        error: null,
      }))
      // app/: page.tsx (file), __catchall_slug__ (folder)
      .mockImplementationOnce(async () => ({
        data: [
          {
            name: "page.tsx",
            id: "obj_root_page",
            metadata: { size: 50, mimetype: "text/plain" },
          },
          { name: "__catchall_slug__", id: null, metadata: null },
        ],
        error: null,
      }))
      // app/__catchall_slug__/: page.tsx (file)
      .mockImplementationOnce(async () => ({
        data: [
          {
            name: "page.tsx",
            id: "obj_cs_page",
            metadata: { size: 60, mimetype: "text/plain" },
          },
        ],
        error: null,
      }));
    const downloadMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        data: new Blob(['{"name":"x"}'], { type: "text/plain" }),
        error: null,
      }))
      .mockImplementationOnce(async () => ({
        data: new Blob(["export default function P() { return null }"], { type: "text/plain" }),
        error: null,
      }))
      .mockImplementationOnce(async () => ({
        data: new Blob(["export default function Slug() { return null }"], { type: "text/plain" }),
        error: null,
      }));
    const supabase = {
      storage: {
        from: () => ({ list: listMock, download: downloadMock }),
      },
    } as unknown as SupabaseClient;

    const files = await downloadProjectTree(supabase, "build-xyz");
    expect(files.map((f) => f.file).sort()).toEqual([
      "app/[...slug]/page.tsx",
      "app/page.tsx",
      "package.json",
    ]);
    const pkg = files.find((f) => f.file === "package.json");
    expect(pkg?.data).toBe('{"name":"x"}');
    expect(pkg?.encoding).toBe("utf-8");
  });

  it("propagates list errors with prefix context", async () => {
    const supabase = {
      storage: {
        from: () => ({
          list: vi.fn(async () => ({ data: null, error: { message: "boom" } })),
          download: vi.fn(),
        }),
      },
    } as unknown as SupabaseClient;
    await expect(downloadProjectTree(supabase, "build-xyz")).rejects.toThrow(/boom/);
  });
});
