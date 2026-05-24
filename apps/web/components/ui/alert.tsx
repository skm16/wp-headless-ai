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
    container: "border-blue/30 bg-blue/10 text-wht",
    title: "text-blue",
  },
  success: {
    container: "border-teal/30 bg-teal/10 text-wht",
    title: "text-teal",
  },
  warning: {
    container: "border-amb/30 bg-amb/10 text-wht",
    title: "text-amb",
  },
  danger: {
    container: "border-red/30 bg-red/10 text-wht",
    title: "text-red",
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
        <div className={cn(title && "mt-1", "text-gry")}>{children}</div>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
