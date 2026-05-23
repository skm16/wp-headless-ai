import type { Event } from "@/lib/this-week/featured-event";

export function FeaturedEventHero({ event }: { event: Event | null }) {
  if (!event) {
    return (
      <section className="rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
        <p className="text-sm text-neutral-500">No upcoming featured event right now. Check back soon.</p>
      </section>
    );
  }

  const acf = event.acf;
  const isFeatured = acf?.is_featured_event === true;

  return (
    <section className="overflow-hidden rounded-lg bg-neutral-900 text-neutral-50 shadow-sm">
      <div className="space-y-4 p-8">
        <span className="inline-block rounded-full bg-amber-400/20 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-amber-300">
          {isFeatured ? "Featured event" : "Next up"}
        </span>
        <h2 className="text-3xl font-semibold tracking-tight">{event.title}</h2>
        {acf?.start_date__time && (
          <p className="text-sm text-neutral-300">{formatEventDate(acf.start_date__time, acf.end_date__time)}</p>
        )}
        {acf?.address && <p className="text-sm text-neutral-400">{acf.address}</p>}
        {event.excerpt && <p className="max-w-2xl text-sm text-neutral-300">{stripHtml(event.excerpt)}</p>}
        <a
          href={event.link}
          className="inline-block rounded border border-neutral-50/30 px-4 py-2 text-sm font-medium text-neutral-50 hover:bg-neutral-50/10"
        >
          Event details →
        </a>
      </div>
    </section>
  );
}

function formatEventDate(startIso: string, endIso?: string): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return startIso;
  const startFmt = formatLong(start);
  if (!endIso) return startFmt;

  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return startFmt;

  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) return `${startFmt} – ${formatTime(end)}`;
  return `${startFmt} – ${formatLong(end)}`;
}

function formatLong(d: Date): string {
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTime(d: Date): string {
  return d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
