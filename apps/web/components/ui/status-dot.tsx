import { cn } from "@/lib/utils";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  pulse?: boolean;
}

const tones: Record<Tone, string> = {
  neutral: "bg-slate-400",
  brand: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

export function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
  ...rest
}: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("relative inline-flex h-2 w-2", className)}
      {...rest}
    >
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            tones[tone],
          )}
        />
      )}
      <span
        className={cn("relative inline-flex h-2 w-2 rounded-full", tones[tone])}
      />
    </span>
  );
}
