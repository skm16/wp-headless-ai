import type { GetEventsOutput } from "@/lib/sdk";

type Event = GetEventsOutput["events"][number];

/**
 * Three upcoming events on a cream backdrop with yellow date chips, matching
 * the actual Two Roads layout. Sorts by event start_date__time ASC and slices
 * to the next 3. Each card has a colored placeholder banner since the WP-side
 * events CPT doesn't currently expose a featured image through the SDK.
 */
export function UpcomingEvents({ events }: { events: Event[] }) {
  const upcoming = pickUpcoming(events);
  if (upcoming.length === 0) return null;

  return (
    <section className="bg-[#fdf7e6] py-16">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-center text-2xl font-bold uppercase tracking-[0.18em] text-[#0c2542] sm:text-3xl">
          Upcoming Events
        </h2>
        <ul className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
          {upcoming.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </ul>
        <div className="mt-12 text-center">
          <a
            href="/events"
            className="inline-block text-sm font-bold uppercase tracking-[0.18em] text-[#0c2542] transition hover:text-[#0c2542]/70"
          >
            View All Events <span aria-hidden>→</span>
          </a>
        </div>
      </div>
    </section>
  );
}

function EventCard({ event }: { event: Event }) {
  const acf = event.acf;
  const start = acf?.start_date__time ? new Date(acf.start_date__time) : null;
  const banner = bannerForEvent(event);

  return (
    <article className="overflow-hidden rounded-md bg-white shadow-sm">
      <div
        className="relative h-44 w-full"
        style={{ backgroundImage: banner.background, backgroundSize: "cover", backgroundPosition: "center" }}
      >
        <div className="absolute inset-0 bg-black/30" />
        <p className="absolute inset-x-0 bottom-6 text-center text-2xl font-bold uppercase tracking-[0.18em] text-white drop-shadow-lg">
          {banner.label}
        </p>
      </div>
      <div className="relative px-5 pb-6 pt-7">
        {start && (
          <DateChip
            month={start.toLocaleString("en-US", { month: "short" })}
            day={String(start.getDate())}
          />
        )}
        <h3 className="text-base font-bold text-[#fcc500]">{event.title}</h3>
        {start && acf?.start_date__time && (
          <p className="mt-1 text-xs text-neutral-500">{formatRange(acf.start_date__time, acf.end_date__time)}</p>
        )}
        {event.excerpt && (
          <p className="mt-3 line-clamp-4 text-sm text-neutral-700">{event.excerpt}</p>
        )}
        <a
          href={event.link}
          className="mt-4 inline-block text-xs font-bold uppercase tracking-[0.18em] text-[#fcc500] hover:text-[#0c2542]"
        >
          Learn More <span aria-hidden>›</span>
        </a>
      </div>
    </article>
  );
}

function DateChip({ month, day }: { month: string; day: string }) {
  return (
    <span className="absolute -top-4 left-5 inline-flex items-center gap-1 rounded-sm bg-[#fcc500] px-3 py-1 text-xs font-bold uppercase tracking-widest text-[#0c2542] shadow-sm">
      {month} {day}
    </span>
  );
}

/**
 * Generates a deterministic, on-brand banner for each event since the WP
 * events CPT doesn't expose its featured image through the current SDK.
 * Uses the event title for variety while keeping the visual rhythm tight.
 */
function bannerForEvent(event: Event): { background: string; label: string } {
  const palette = [
    "linear-gradient(135deg, #5b1d6a 0%, #d61680 100%)",
    "linear-gradient(135deg, #0c2542 0%, #1f4673 50%, #fcc500 120%)",
    "linear-gradient(135deg, #ce8b1a 0%, #fcc500 100%)",
    "linear-gradient(135deg, #2d4a26 0%, #6cab44 100%)",
  ];
  const idx = (event.id || event.title.length) % palette.length;
  // Pull a 1-2 word punchy label out of the title.
  const words = event.title.split(/\s+/).filter(Boolean);
  const label = words.length <= 2 ? event.title : `${words[0]} ${words[1] ?? ""}`.trim();
  return { background: palette[idx]!, label: label.toUpperCase() };
}

function pickUpcoming(events: Event[]): Event[] {
  const now = Date.now();
  return events
    .map((e) => ({ event: e, start: parseStart(e.acf?.start_date__time) }))
    .filter((row): row is { event: Event; start: number } => row.start !== null && row.start >= now)
    .sort((a, b) => a.start - b.start)
    .slice(0, 3)
    .map((row) => row.event);
}

function parseStart(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function formatRange(startIso: string, endIso?: string): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return startIso;
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  if (!endIso) return fmt(start);
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return fmt(start);
  if (start.toDateString() === end.toDateString()) {
    return `${fmt(start)} – ${end.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  }
  return `${fmt(start)} – ${fmt(end)}`;
}
