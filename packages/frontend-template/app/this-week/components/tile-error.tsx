/**
 * Rendered in place of a tile when its underlying ability call rejected.
 * Keeps a composed dashboard partial-failure-tolerant: one bad upstream
 * downgrades to one bad tile, not a whole-page error.
 */
export function TileError({ label, reason }: { label: string; reason: unknown }) {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return (
    <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">Couldn&apos;t load {label}.</p>
      <p className="mt-1 text-xs text-amber-800">{detail}</p>
    </section>
  );
}
