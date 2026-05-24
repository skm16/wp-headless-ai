import { forwardRef, useId } from "react";
import { cn } from "@/lib/utils";

export interface FieldProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Hide the label visually (still announced to assistive tech). Use when an
   *  adjacent button or row context makes the label redundant for sighted users. */
  labelHidden?: boolean;
  hint?: string;
  error?: string;
  id?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, labelHidden = false, hint, error, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={inputId}
        className={cn(
          "block font-mono text-[11px] uppercase tracking-[0.1em] text-gry-d",
          labelHidden && "sr-only",
        )}
      >
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(" ") || undefined}
        className={cn(
          "block w-full rounded-md border bg-surf px-3 py-2 text-sm text-wht transition-colors placeholder:text-gry-d",
          "focus:outline-none focus:ring-2 focus:ring-offset-0",
          error
            ? "border-red focus:border-red focus:ring-red/40"
            : "border-bord focus:border-teal focus:ring-teal/30",
          "disabled:cursor-not-allowed disabled:bg-bg disabled:text-gry-d",
          className,
        )}
        {...rest}
      />
      {hint && !error && (
        <p id={hintId} className="text-xs text-gry">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-red" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});
