import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { pageInventory, blockInventory } from "@/lib/db/schema";
import { buildCarryForwardUpdates, PAGE_INVENTORY_CLONE_COLUMNS, BLOCK_INVENTORY_CLONE_COLUMNS } from "./edit-site.helpers";

describe("buildCarryForwardUpdates", () => {
  it("emits an inherited approver/timestamp for untouched pages and nulls for reset pages", () => {
    const updates = buildCarryForwardUpdates({
      carry: [
        { pageInventoryId: "r-home", status: "pending" },
        { pageInventoryId: "r-about", status: "approved" },
      ],
      resetToPending: ["home"],
      resultIdToSlug: new Map([
        ["r-home", "home"],
        ["r-about", "about"],
      ]),
      sourceSlugMeta: new Map([
        ["about", { approvedByUserId: "u1", approvedAt: "2026-06-01T00:00:00Z" }],
        ["home", { approvedByUserId: "u9", approvedAt: "2026-05-30T00:00:00Z" }],
      ]),
    });
    const byId = new Map(updates.map((u) => [u.pageInventoryId, u]));
    // reset page → pending + null approver/timestamp.
    expect(byId.get("r-home")).toEqual({
      pageInventoryId: "r-home",
      approvalStatus: "pending",
      approvedByUserId: null,
      approvedAt: null,
    });
    // untouched inherited page → carries the source approver + timestamp.
    expect(byId.get("r-about")).toEqual({
      pageInventoryId: "r-about",
      approvalStatus: "approved",
      approvedByUserId: "u1",
      approvedAt: "2026-06-01T00:00:00Z",
    });
  });

  it("yields null provenance for an inherited page with no sourceSlugMeta entry", () => {
    const updates = buildCarryForwardUpdates({
      carry: [{ pageInventoryId: "r-contact", status: "approved_with_issues" }],
      resetToPending: [],
      resultIdToSlug: new Map([["r-contact", "contact"]]),
      sourceSlugMeta: new Map(), // no entry for "contact"
    });
    expect(updates[0]).toEqual({
      pageInventoryId: "r-contact",
      approvalStatus: "approved_with_issues",
      approvedByUserId: null,
      approvedAt: null,
    });
  });

  it("yields null provenance for a carry item whose pageInventoryId has no slug mapping", () => {
    const updates = buildCarryForwardUpdates({
      carry: [{ pageInventoryId: "r-orphan", status: "approved" }],
      resetToPending: [],
      resultIdToSlug: new Map(), // no mapping for "r-orphan"
      sourceSlugMeta: new Map([["anything", { approvedByUserId: "u1", approvedAt: "2026-06-01T00:00:00Z" }]]),
    });
    expect(updates[0]).toEqual({
      pageInventoryId: "r-orphan",
      approvalStatus: "approved",
      approvedByUserId: null,
      approvedAt: null,
    });
  });
});

describe("PAGE_INVENTORY_CLONE_COLUMNS", () => {
  const cols = PAGE_INVENTORY_CLONE_COLUMNS.split(",").map((c) => c.trim());

  it("carries block_tree — without it the NEXT edit fail-closes to all-pages re-review", () => {
    expect(cols).toContain("block_tree");
  });

  it("carries source_modified_gmt — without it JAB_INCREMENTAL_SKIP degrades to full sync", () => {
    expect(cols).toContain("source_modified_gmt");
  });

  it("carries every column loadSourcePagesForImpact reads (slug, block_tree)", () => {
    expect(cols).toEqual(expect.arrayContaining(["slug", "block_tree"]));
  });
});

describe("clone column completeness (schema-derived)", () => {
  // Columns deliberately NOT cloned: identity/scoping keys are re-set by the
  // row mapper; created_at takes the DB default on the cloned row.
  // Migration 0034 (AI-call-optimization Phase 1): the four new block_inventory
  // columns are excluded from the clone set until Phase 4 decides carry-forward
  // semantics — input_tokens_cache_creation + failure_kind are per-generation
  // telemetry (the clone regenerates, so prior-build telemetry is irrelevant),
  // and prompt_inputs_hash + reused_from_build_id are Phase 4 provenance columns
  // that only make sense once Phase 4 cross-build carry-forward is wired.
  const EXCLUDED = new Set([
    "id", "site_build_id", "project_id", "created_at",
    // Phase 4 decides; excluded from clone until then:
    "input_tokens_cache_creation", "failure_kind",
    "prompt_inputs_hash", "reused_from_build_id",
  ]);

  it("PAGE_INVENTORY_CLONE_COLUMNS covers every page_inventory schema column except the exclusions", () => {
    const schemaCols = Object.values(getTableColumns(pageInventory)).map((c) => c.name);
    const expected = schemaCols.filter((c) => !EXCLUDED.has(c)).sort();
    const actual = PAGE_INVENTORY_CLONE_COLUMNS.split(",").map((c) => c.trim()).sort();
    expect(actual).toEqual(expected);
  });

  it("BLOCK_INVENTORY_CLONE_COLUMNS covers every block_inventory schema column except the exclusions", () => {
    const schemaCols = Object.values(getTableColumns(blockInventory)).map((c) => c.name);
    const expected = schemaCols.filter((c) => !EXCLUDED.has(c)).sort();
    const actual = BLOCK_INVENTORY_CLONE_COLUMNS.split(",").map((c) => c.trim()).sort();
    expect(actual).toEqual(expected);
  });
});
