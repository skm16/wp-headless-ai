"use client";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * Controlled segmented selector. ARIA radiogroup pattern with arrow-key
 * navigation. Use for binary or ternary choices where every option is visible
 * (don't reach for a Select when there are 2–3 options).
 *
 * Consumers: OwnershipPicker (WP-managed / Jab-managed), upcoming IterationPanel
 * content/design toggle, PreviewFrame's eventual icon-driven device toggle.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = "md",
  className,
}: SegmentedProps<T>) {
  function handleKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = nextEnabledIdx(options, idx, 1);
      if (next !== -1) onChange(options[next]!.value);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const prev = nextEnabledIdx(options, idx, -1);
      if (prev !== -1) onChange(options[prev]!.value);
    }
  }

  const sizing = size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-3 text-sm";

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-slate-200 bg-slate-50 p-0.5",
        className,
      )}
    >
      {options.map((option, idx) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.description ?? option.label}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            onClick={() => !option.disabled && onChange(option.value)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={cn(
              "inline-flex items-center justify-center rounded font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
              sizing,
              selected
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900",
              option.disabled && "cursor-not-allowed opacity-50 hover:text-slate-600",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function nextEnabledIdx<T extends string>(
  options: SegmentedOption<T>[],
  from: number,
  direction: 1 | -1,
): number {
  const len = options.length;
  for (let step = 1; step <= len; step++) {
    const idx = (from + direction * step + len) % len;
    if (!options[idx]?.disabled) return idx;
  }
  return -1;
}
