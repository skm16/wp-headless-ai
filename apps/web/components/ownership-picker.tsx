"use client";

import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";

export type OwnershipMode = "wp-managed" | "jab-managed";

export interface WPContentType {
  /** WP post type / taxonomy slug — e.g. "post", "page", "event". */
  slug: string;
  /** Display name, plural — e.g. "Pages", "Posts", "Events". */
  pluralName: string;
  /** Single-line context for the row, e.g. "Page post type", "Custom post type". */
  kindLabel: string;
  /** Number of existing entries. Used by the migration-confirmation flow. */
  count: number;
  /** Default per §10 #13: Jab-managed for pages, WP-managed for collections. */
  recommendedMode: OwnershipMode;
}

export interface OwnershipPickerProps {
  types: WPContentType[];
  value: Record<string, OwnershipMode>;
  onChange: (slug: string, next: OwnershipMode) => void;
  /**
   * Fires when a row would change from WP-managed → Jab-managed on a type
   * with existing entries. The parent owns the modal UI; call `confirm()`
   * to commit the change. If not provided, WP→Jab changes commit unconditionally.
   */
  onMigrationRequired?: (type: WPContentType, confirm: () => void) => void;
  className?: string;
}

const SEGMENTED_OPTIONS: SegmentedOption<OwnershipMode>[] = [
  { value: "wp-managed", label: "WP-managed" },
  { value: "jab-managed", label: "Jab-managed" },
];

/**
 * §12 step 5 + §13. Per-content-type ownership assignment.
 *
 * Each row pre-selects the recommended mode (Jab-managed for pages,
 * WP-managed for collections); the choice is always explicit and visible.
 * Source-of-truth flips never happen silently — the parent gets a chance to
 * confirm migrations via onMigrationRequired.
 */
export function OwnershipPicker({
  types,
  value,
  onChange,
  onMigrationRequired,
  className,
}: OwnershipPickerProps) {
  if (types.length === 0) {
    return (
      <EmptyState
        title="No content types found"
        description="We couldn't enumerate any post types or taxonomies from this WordPress site. Make sure WP is reachable and try again."
        className={className}
      />
    );
  }

  function requestChange(type: WPContentType, next: OwnershipMode) {
    const current = value[type.slug] ?? type.recommendedMode;
    if (current === next) return;
    const needsMigration =
      current === "wp-managed" && next === "jab-managed" && type.count > 0;
    if (needsMigration && onMigrationRequired) {
      onMigrationRequired(type, () => onChange(type.slug, next));
      return;
    }
    onChange(type.slug, next);
  }

  return (
    <ul
      className={cn(
        "divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white",
        className,
      )}
    >
      {types.map((type) => {
        const current = value[type.slug] ?? type.recommendedMode;
        const willMigrate = current === "jab-managed" && type.count > 0;
        return (
          <li
            key={type.slug}
            className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">
                {type.pluralName}{" "}
                <span className="font-normal text-slate-500">
                  · {type.count} {type.count === 1 ? "item" : "items"}
                </span>
              </p>
              <p
                className={cn(
                  "mt-0.5 text-xs",
                  willMigrate ? "text-warning-strong" : "text-slate-500",
                )}
              >
                {willMigrate
                  ? `Will copy ${type.count} ${type.count === 1 ? "item" : "items"} from WordPress into Jab on save`
                  : `${type.kindLabel} · ${labelFor(type.recommendedMode)} recommended`}
              </p>
            </div>
            <Segmented
              value={current}
              onChange={(next) => requestChange(type, next)}
              options={SEGMENTED_OPTIONS}
              ariaLabel={`Content source for ${type.pluralName}`}
            />
          </li>
        );
      })}
    </ul>
  );
}

function labelFor(mode: OwnershipMode): string {
  return mode === "jab-managed" ? "Jab-managed" : "WP-managed";
}
