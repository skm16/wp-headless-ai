/**
 * Picks the soonest *upcoming* event flagged `is_featured_event` for the
 * `/this-week` hero. Falls back to the soonest upcoming non-featured event
 * if no featured event is upcoming. Returns null only when there are no
 * events with a parseable start date in the future.
 */

import type { GetEventsOutput } from "@/lib/sdk";

export type Event = GetEventsOutput["events"][number];

export function pickFeaturedEvent(events: Event[], now: Date = new Date()): Event | null {
  const annotated = events
    .map((e) => ({ event: e, start: parseStart(e.acf?.start_date__time) }))
    .filter((row): row is { event: Event; start: number } => row.start !== null && row.start >= now.getTime())
    .sort((a, b) => a.start - b.start);

  const featured = annotated.find((row) => row.event.acf?.is_featured_event === true);
  if (featured) return featured.event;
  return annotated[0]?.event ?? null;
}

function parseStart(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}
