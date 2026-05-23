"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

export type ProjectIntent = "faithful" | "refresh" | "reimagine";

export interface IntentOption {
  value: ProjectIntent;
  label: string;
  description: string;
}

/**
 * The three intents per §10 #7 of the design plan. Copy carries the
 * expectation calibration so "Faithful" reads as structural similarity, not
 * pixel-exact. Don't rephrase without revisiting that decision — it's
 * load-bearing.
 */
export const INTENT_OPTIONS: IntentOption[] = [
  {
    value: "faithful",
    label: "Faithful",
    description:
      "Keep the existing structure and content priority. Good for sites that mostly need a speed and polish update.",
  },
  {
    value: "refresh",
    label: "Refresh",
    description:
      "Same content, fresh design. Best for clients who want an update within their existing brand.",
  },
  {
    value: "reimagine",
    label: "Reimagine",
    description:
      "Start from scratch. Best for clients who want a real redesign anyway.",
  },
];

export interface IntentPickerProps {
  value: ProjectIntent;
  onChange: (next: ProjectIntent) => void;
  className?: string;
}

/**
 * Three-option intent selector. Used at §12 step 4 (post-signup) and inside
 * the IntentChip edit modal. Uses the radiogroup ARIA pattern; arrow-key
 * traversal lives in the option buttons via tabIndex management.
 */
export function IntentPicker({ value, onChange, className }: IntentPickerProps) {
  // Refs keyed by option index so arrow-key navigation focuses the correct
  // instance even if multiple IntentPickers coexist on the page (e.g. an
  // open edit modal while the workspace chip is still visible). A
  // document.querySelector approach would grab the first DOM match
  // regardless of which picker the user was interacting with.
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = (idx + 1) % INTENT_OPTIONS.length;
      onChange(INTENT_OPTIONS[next]!.value);
      optionRefs.current[next]?.focus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = (idx - 1 + INTENT_OPTIONS.length) % INTENT_OPTIONS.length;
      onChange(INTENT_OPTIONS[prev]!.value);
      optionRefs.current[prev]?.focus();
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Project intent"
      className={cn("grid gap-3 sm:grid-cols-3", className)}
    >
      {INTENT_OPTIONS.map((option, idx) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              optionRefs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={cn(
              "group relative flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2",
              selected
                ? "border-brand bg-brand-muted"
                : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50",
            )}
          >
            <span className="flex items-center justify-between">
              <span
                className={cn(
                  "text-sm font-semibold",
                  selected ? "text-brand-strong" : "text-slate-900",
                )}
              >
                {option.label}
              </span>
              <SelectMark selected={selected} />
            </span>
            <span
              className={cn(
                "text-xs leading-relaxed",
                selected ? "text-brand-strong/80" : "text-slate-600",
              )}
            >
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SelectMark({ selected }: { selected: boolean }) {
  if (selected) {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white">
        <svg
          className="h-3 w-3"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M13.4 4.6a1 1 0 010 1.4l-6 6a1 1 0 01-1.4 0l-3-3a1 1 0 011.4-1.4L6.7 9.9l5.3-5.3a1 1 0 011.4 0z" />
        </svg>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="h-5 w-5 rounded-full border border-slate-300 transition-colors group-hover:border-slate-400"
    />
  );
}

export interface IntentChipProps {
  value: ProjectIntent;
  onEdit?: () => void;
  className?: string;
}

/**
 * Compact chip showing the current project intent with an Edit affordance.
 * Lives on the project workspace next to the project name per §12 "Intent
 * chip + edit affordance." Caller decides what onEdit does — typically open
 * a modal containing IntentPicker.
 */
export function IntentChip({ value, onEdit, className }: IntentChipProps) {
  const option = INTENT_OPTIONS.find((o) => o.value === value);
  if (!option) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full bg-brand-muted py-1 pl-3 pr-1 text-xs font-medium text-brand-strong",
        className,
      )}
    >
      <span>{option.label}</span>
      {onEdit && (
        <>
          <span aria-hidden="true" className="text-brand-strong/40">
            ·
          </span>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-full px-2 py-0.5 text-brand-strong/80 hover:bg-brand/10 hover:text-brand-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Edit →
          </button>
        </>
      )}
    </span>
  );
}
