/**
 * Hand-crafted server-side helpers for `/this-week`. Lives outside `lib/sdk/`
 * because it composes already-fetched ability data — `wpheadless sync` will
 * never touch this file.
 */

import type { GetFoodTruckEventsOutput } from "@/lib/sdk";

export type FoodTruckEvent = GetFoodTruckEventsOutput["food_truck_events"][number];

export interface DaySchedule {
  /** Local-midnight Date for the day this entry covers. */
  day: Date;
  /** Trucks active on this day, in stable input order. */
  trucks: FoodTruckEvent[];
}

/**
 * Resolves which trucks are active on a single calendar day.
 *
 * Two patterns are supported, mirroring the WP-side ACF schema:
 *  - One-shot:  `is_reoccurring=false` with `start_date`..`end_date`.
 *  - Recurring: `is_reoccurring=true`  with `reoccurring_start_date`..
 *               `reoccurring_end_date` AND a `days_of_the_week` set
 *               (string day numbers, "0"=Sunday … "6"=Saturday).
 *
 * Trucks with malformed/missing dates are skipped silently — WP authors
 * sometimes save partial drafts, and a `/this-week` page should degrade
 * to "fewer trucks shown" rather than crash.
 */
export function resolveFoodTrucksForDay(
  trucks: FoodTruckEvent[],
  day: Date,
): FoodTruckEvent[] {
  const dayKey = toDayKey(day);
  if (dayKey === null) return [];
  const dow = String(day.getDay()) as "0" | "1" | "2" | "3" | "4" | "5" | "6";

  return trucks.filter((t) => {
    const acf = t.acf;
    if (!acf) return false;

    if (acf.is_reoccurring) {
      const start = toDayKey(acf.reoccurring_start_date);
      const end = toDayKey(acf.reoccurring_end_date);
      if (start === null || end === null) return false;
      if (dayKey < start || dayKey > end) return false;
      return Array.isArray(acf.days_of_the_week) && acf.days_of_the_week.includes(dow);
    }

    const start = toDayKey(acf.start_date);
    const end = toDayKey(acf.end_date ?? acf.start_date);
    if (start === null || end === null) return false;
    return dayKey >= start && dayKey <= end;
  });
}

/**
 * Builds a 7-day schedule starting at `startDay`, returning a stable array
 * the page can render without further computation.
 */
export function buildWeekSchedule(
  trucks: FoodTruckEvent[],
  startDay: Date,
): DaySchedule[] {
  const out: DaySchedule[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(startDay, i);
    out.push({ day, trucks: resolveFoodTrucksForDay(trucks, day) });
  }
  return out;
}

/**
 * Returns the local-midnight Date for "today" relative to the server clock.
 * Pulled out so callers can pass a fixed date in tests.
 */
export function startOfToday(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * Normalizes any "YYYY-MM-DD" prefix (or Date) to a sortable key.
 * ACF date pickers emit "YYYY-MM-DD"; date-time fields prefix that with the
 * date portion, so a prefix slice is enough — and string comparison on
 * "YYYY-MM-DD" is correct lexicographically.
 */
function toDayKey(value: string | Date | undefined | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const trimmed = value.trim();
  if (trimmed.length < 10) return null;
  const candidate = trimmed.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  return candidate;
}
