import type { DaySchedule } from "@/lib/this-week/food-truck-schedule";

export function FoodTruckWeek({ week }: { week: DaySchedule[] }) {
  return (
    <section className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Food trucks this week</h2>
        <p className="text-xs uppercase tracking-wide text-neutral-400">
          Resolved server-side from recurring + one-shot schedules
        </p>
      </header>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-7">
        {week.map(({ day, trucks }, idx) => (
          <li
            key={day.toISOString()}
            className="flex flex-col gap-2 rounded border border-neutral-200 bg-white p-3"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                {dayLabel(day, idx)}
              </span>
              <span className="text-xs text-neutral-400">{shortDate(day)}</span>
            </div>
            {trucks.length === 0 ? (
              <p className="text-sm text-neutral-300">—</p>
            ) : (
              <ul className="space-y-1.5">
                {trucks.map((t) => (
                  <li
                    key={t.id}
                    className="rounded px-2 py-1 text-xs font-medium leading-snug"
                    style={{
                      backgroundColor: tintColor(t.acf?.color, 0.15),
                      color: textOn(t.acf?.color),
                    }}
                  >
                    {t.title}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function dayLabel(d: Date, idx: number): string {
  if (idx === 0) return "Today";
  if (idx === 1) return "Tomorrow";
  return d.toLocaleString("en-US", { weekday: "short" });
}

function shortDate(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
}

function tintColor(raw: string | undefined, alpha: number): string {
  const hex = normalizeHex(raw);
  if (!hex) return "#f5f5f4";
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function textOn(raw: string | undefined): string {
  const hex = normalizeHex(raw);
  if (!hex) return "#1c1917";
  const { r, g, b } = hexToRgb(hex);
  const darken = (c: number) => Math.round(c * 0.5);
  return `rgb(${darken(r)}, ${darken(g)}, ${darken(b)})`;
}

function normalizeHex(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/#?([0-9a-fA-F]{6})/);
  return m ? `#${m[1].toLowerCase()}` : null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}
