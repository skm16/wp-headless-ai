import { cn } from "@/lib/utils";

type Tone = "info" | "success" | "warning" | "danger";

type AlertRole = "alert" | "status";

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "role"> {
  tone?: Tone;
  title?: string;
  action?: React.ReactNode;
  /**
   * ARIA live-region role. Default: `alert` for danger, `status` otherwise.
   * Override to `status` on non-blocking warnings (quota approaching, "we'll
   * walk you through this later") so screen readers don't announce them
   * interruptively. Override to `alert` on warnings that block user
   * progress (failed form submit, broken connection).
   */
  role?: AlertRole;
}

const tones: Record<Tone, { container: string; title: string }> = {
  info: {
    container: "border-info/30 bg-info-muted text-info-strong",
    title: "text-info-strong",
  },
  success: {
    container: "border-success/30 bg-success-muted text-success-strong",
    title: "text-success-strong",
  },
  warning: {
    container: "border-warning/30 bg-warning-muted text-warning-strong",
    title: "text-warning-strong",
  },
  danger: {
    container: "border-danger/30 bg-danger-muted text-danger-strong",
    title: "text-danger-strong",
  },
};

export function Alert({
  tone = "info",
  title,
  action,
  role,
  className,
  children,
  ...rest
}: AlertProps) {
  const t = tones[tone];
  // Default to `alert` only for `danger` (truly interruptive). Warnings
  // historically used `alert` too but that announced quota meters and other
  // non-blocking surfaces interruptively to screen readers. Consumers that
  // need the louder role can pass `role="alert"` explicitly.
  const resolvedRole = role ?? (tone === "danger" ? "alert" : "status");
  return (
    <div
      role={resolvedRole}
      className={cn(
        "flex items-start gap-3 rounded-md border px-4 py-3 text-sm",
        t.container,
        className,
      )}
      {...rest}
    >
      <div className="min-w-0 flex-1">
        {title && <p className={cn("font-semibold", t.title)}>{title}</p>}
        <div className={cn(title && "mt-1")}>{children}</div>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
