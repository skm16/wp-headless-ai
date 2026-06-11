import { describe, it, expect } from "vitest";
import {
  effectiveUnitVersions,
  nextUnitVersionNo,
  unionChangedSlugs,
  type DraftVersionRow,
  type DraftStepRow,
} from "./state";

const v = (over: Partial<DraftVersionRow>): DraftVersionRow => ({
  id: "v1",
  unit_key: "acf/hero",
  version_no: 1,
  created_by_edit_id: "e1",
  ...over,
});
const s = (over: Partial<DraftStepRow>): DraftStepRow => ({
  id: "e1",
  status: "completed",
  undone_at: null,
  changed_slugs: null,
  created_at: "2026-06-10T12:00:00Z",
  ...over,
});

describe("effectiveUnitVersions", () => {
  it("picks the latest non-undone version per unit", () => {
    const versions = [
      v({ id: "v1", version_no: 1, created_by_edit_id: "e1" }),
      v({ id: "v2", version_no: 2, created_by_edit_id: "e2" }),
    ];
    const steps = [s({ id: "e1" }), s({ id: "e2" })];
    const eff = effectiveUnitVersions(versions, steps);
    expect(eff.get("acf/hero")?.id).toBe("v2");
  });

  it("falls back to the prior version when the latest step is undone (the undo)", () => {
    const versions = [
      v({ id: "v1", version_no: 1, created_by_edit_id: "e1" }),
      v({ id: "v2", version_no: 2, created_by_edit_id: "e2" }),
    ];
    const steps = [s({ id: "e1" }), s({ id: "e2", undone_at: "2026-06-10T13:00:00Z" })];
    expect(effectiveUnitVersions(versions, steps).get("acf/hero")?.id).toBe("v1");
  });

  it("drops the unit entirely when all its versions are undone (back to base)", () => {
    const versions = [v({ id: "v1", created_by_edit_id: "e1" })];
    const steps = [s({ id: "e1", undone_at: "2026-06-10T13:00:00Z" })];
    expect(effectiveUnitVersions(versions, steps).size).toBe(0);
  });

  it("keeps versions whose edit row is missing (defensive: never lose committed work)", () => {
    const versions = [v({ id: "v1", created_by_edit_id: "e-gone" })];
    expect(effectiveUnitVersions(versions, []).get("acf/hero")?.id).toBe("v1");
  });

  it("suppresses version rows whose creating step is still running (crash-before-bump guard)", () => {
    // A worker inserted a draft_unit_versions row and then crashed before
    // bumpDraftVersion. The edit stays 'running' (later swept to 'failed' by
    // autoFailStaleOpenEdits). Its version row must NOT bleed into subsequent
    // edits' effective base — if it did, the in-flight patch would be silently
    // applied without ever going through the LLM / review flow.
    const versions = [v({ id: "v1", created_by_edit_id: "e1" })];
    const steps = [s({ id: "e1", status: "running" })];
    expect(effectiveUnitVersions(versions, steps).size).toBe(0);
  });

  it("suppresses version rows whose creating step failed", () => {
    const versions = [v({ id: "v1", created_by_edit_id: "e1" })];
    const steps = [s({ id: "e1", status: "failed" })];
    expect(effectiveUnitVersions(versions, steps).size).toBe(0);
  });
});

describe("nextUnitVersionNo", () => {
  it("is 1 for a fresh unit and max+1 otherwise (counts undone versions too — ids never reuse)", () => {
    expect(nextUnitVersionNo([], "acf/hero")).toBe(1);
    const versions = [v({ version_no: 1 }), v({ version_no: 2 })];
    expect(nextUnitVersionNo(versions, "acf/hero")).toBe(3);
    expect(nextUnitVersionNo(versions, "shell:header")).toBe(1);
  });
});

describe("unionChangedSlugs", () => {
  it("unions changed_slugs across active completed steps only", () => {
    const steps = [
      s({ id: "e1", changed_slugs: ["home", "about"] }),
      s({ id: "e2", changed_slugs: ["about", "beers"] }),
      s({ id: "e3", changed_slugs: ["contact"], undone_at: "2026-06-10T13:00:00Z" }),
      s({ id: "e4", status: "failed", changed_slugs: ["never"] }),
    ];
    expect(unionChangedSlugs(steps).sort()).toEqual(["about", "beers", "home"]);
  });

  it("returns empty for no active steps", () => {
    expect(unionChangedSlugs([])).toEqual([]);
  });
});
