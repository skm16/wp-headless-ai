import { cn } from "@/lib/utils";
import type { OwnershipMode } from "@/components/ownership-picker";

export interface ContentDocStatusProps {
  value: OwnershipMode;
  className?: string;
}

/**
 * Compact badge surfacing the content-source distinction from §13. Used per
 * row on the Pages list to make ownership scannable — clicking through to
 * edit a row routes to wp-admin or the IterationPanel based on this value.
 *
 * Intentionally NOT a generic Badge usage: the WP-managed / Jab-managed
 * vocabulary is load-bearing copy from §13. Consolidating the labels here
 * keeps every surface speaking the same words.
 */
export function ContentDocStatus({ value, className }: ContentDocStatusProps) {
  const meta = META[value];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        meta.cls,
        className,
      )}
      title={meta.title}
    >
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 rounded-full", meta.dot)}
      />
      {meta.label}
    </span>
  );
}

const META: Record<
  OwnershipMode,
  { label: string; cls: string; dot: string; title: string }
> = {
  "wp-managed": {
    label: "WP-managed",
    cls: "bg-elev text-gry",
    dot: "bg-gry-d",
    title: "Edited in WordPress; pulled live at runtime",
  },
  "jab-managed": {
    label: "Jab-managed",
    cls: "bg-teal/10 text-teal",
    dot: "bg-teal",
    title: "Edited in Jab through the iteration loop",
  },
};
