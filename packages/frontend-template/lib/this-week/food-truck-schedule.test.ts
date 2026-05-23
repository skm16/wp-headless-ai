/**
 * Run with: pnpm exec tsx --test lib/this-week/food-truck-schedule.test.ts
 *
 * No bundler test runner needed — Node 20+ ships `node:test`, and `tsx` is
 * already a devDependency of this template, so these tests run zero-config.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildWeekSchedule,
  resolveFoodTrucksForDay,
  startOfToday,
  type FoodTruckEvent,
} from "./food-truck-schedule";

function truck(overrides: Partial<FoodTruckEvent["acf"]> & { title: string }): FoodTruckEvent {
  const { title, ...acf } = overrides;
  return {
    id: 0,
    title,
    excerpt: "",
    date: "2026-01-01T00:00:00Z",
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    link: "https://example.test/",
    acf,
  };
}

const TUE_MAY_5 = new Date(2026, 4, 5); // Tue 2026-05-05 — May is month index 4
const WED_MAY_6 = new Date(2026, 4, 6);
const SUN_MAY_10 = new Date(2026, 4, 10);

describe("resolveFoodTrucksForDay — one-shot trucks", () => {
  it("includes a truck whose [start_date, end_date] window covers the day", () => {
    const t = truck({ title: "One shot", is_reoccurring: false, start_date: "2026-05-04", end_date: "2026-05-06" });
    assert.deepEqual(resolveFoodTrucksForDay([t], TUE_MAY_5).map((x) => x.title), ["One shot"]);
  });

  it("excludes a truck whose window is entirely before the day", () => {
    const t = truck({ title: "Past", is_reoccurring: false, start_date: "2026-04-30", end_date: "2026-05-01" });
    assert.deepEqual(resolveFoodTrucksForDay([t], TUE_MAY_5), []);
  });

  it("treats missing end_date as a single-day event on start_date", () => {
    const t = truck({ title: "Single day", is_reoccurring: false, start_date: "2026-05-05" });
    assert.equal(resolveFoodTrucksForDay([t], TUE_MAY_5).length, 1);
    assert.equal(resolveFoodTrucksForDay([t], WED_MAY_6).length, 0);
  });

  it("skips trucks with malformed dates rather than throwing", () => {
    const t = truck({ title: "Bad", is_reoccurring: false, start_date: "not-a-date" });
    assert.deepEqual(resolveFoodTrucksForDay([t], TUE_MAY_5), []);
  });
});

describe("resolveFoodTrucksForDay — recurring trucks", () => {
  it("includes a recurring truck when day-of-week matches and date in window", () => {
    const t = truck({
      title: "Tuesday regular",
      is_reoccurring: true,
      reoccurring_start_date: "2026-01-01",
      reoccurring_end_date: "2026-12-31",
      days_of_the_week: ["2"], // Tuesday
    });
    assert.equal(resolveFoodTrucksForDay([t], TUE_MAY_5).length, 1);
    assert.equal(resolveFoodTrucksForDay([t], WED_MAY_6).length, 0);
  });

  it("excludes a recurring truck whose window has not started", () => {
    const t = truck({
      title: "Future recurring",
      is_reoccurring: true,
      reoccurring_start_date: "2027-01-01",
      reoccurring_end_date: "2027-12-31",
      days_of_the_week: ["2"],
    });
    assert.deepEqual(resolveFoodTrucksForDay([t], TUE_MAY_5), []);
  });

  it("supports multi-day recurrence", () => {
    const t = truck({
      title: "Weekend",
      is_reoccurring: true,
      reoccurring_start_date: "2026-01-01",
      reoccurring_end_date: "2026-12-31",
      days_of_the_week: ["0", "6"], // Sun + Sat
    });
    assert.equal(resolveFoodTrucksForDay([t], SUN_MAY_10).length, 1);
    assert.equal(resolveFoodTrucksForDay([t], TUE_MAY_5).length, 0);
  });

  it("excludes recurring trucks with no days_of_the_week set", () => {
    const t = truck({
      title: "Misconfigured",
      is_reoccurring: true,
      reoccurring_start_date: "2026-01-01",
      reoccurring_end_date: "2026-12-31",
    });
    assert.deepEqual(resolveFoodTrucksForDay([t], TUE_MAY_5), []);
  });
});

describe("resolveFoodTrucksForDay — mixed list", () => {
  it("preserves input order and handles both patterns at once", () => {
    const trucks = [
      truck({ title: "A-recurring", is_reoccurring: true, reoccurring_start_date: "2026-01-01", reoccurring_end_date: "2026-12-31", days_of_the_week: ["2"] }),
      truck({ title: "B-oneshot",   is_reoccurring: false, start_date: "2026-05-05", end_date: "2026-05-05" }),
      truck({ title: "C-skipped",   is_reoccurring: false, start_date: "2026-06-01", end_date: "2026-06-01" }),
    ];
    assert.deepEqual(
      resolveFoodTrucksForDay(trucks, TUE_MAY_5).map((x) => x.title),
      ["A-recurring", "B-oneshot"],
    );
  });
});

describe("buildWeekSchedule", () => {
  it("returns 7 entries starting at the requested day", () => {
    const week = buildWeekSchedule([], TUE_MAY_5);
    assert.equal(week.length, 7);
    assert.equal(week[0]?.day.toDateString(), TUE_MAY_5.toDateString());
    assert.equal(week[6]?.day.toDateString(), new Date(2026, 4, 11).toDateString());
  });

  it("populates each day's truck list independently", () => {
    const trucks = [
      truck({ title: "Tue-only", is_reoccurring: true, reoccurring_start_date: "2026-01-01", reoccurring_end_date: "2026-12-31", days_of_the_week: ["2"] }),
    ];
    const week = buildWeekSchedule(trucks, TUE_MAY_5);
    assert.equal(week[0]?.trucks.length, 1, "Tuesday should have the truck");
    assert.equal(week[1]?.trucks.length, 0, "Wednesday should not");
  });
});

describe("startOfToday", () => {
  it("zeroes the time portion at local midnight", () => {
    const now = new Date(2026, 4, 5, 14, 30, 12, 500);
    const start = startOfToday(now);
    assert.equal(start.getHours(), 0);
    assert.equal(start.getMinutes(), 0);
    assert.equal(start.getSeconds(), 0);
    assert.equal(start.getMilliseconds(), 0);
    assert.equal(start.toDateString(), now.toDateString());
  });
});
