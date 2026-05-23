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
    <div className="space-y-1">
      <label
        htmlFor={inputId}
        className={cn(
          "block text-sm font-medium text-slate-700",
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
          "block w-full rounded-md border px-3 py-2 text-sm text-slate-900 transition-colors",
          "focus:outline-none focus:ring-2 focus:ring-offset-0",
          error
            ? "border-danger focus:border-danger focus:ring-danger/40"
            : "border-slate-300 focus:border-brand focus:ring-brand/30",
          "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500",
          className,
        )}
        {...rest}
      />
      {hint && !error && (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger-strong" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});
