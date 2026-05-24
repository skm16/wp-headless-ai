import { cn } from "@/lib/utils";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

const tones: Record<Tone, string> = {
  neutral: "bg-elev text-gry border border-bord",
  brand: "bg-teal/10 text-teal border border-teal/20",
  success: "bg-teal/10 text-teal border border-teal/20",
  warning: "bg-amb/10 text-amb border border-amb/20",
  danger: "bg-red/10 text-red border border-red/20",
  info: "bg-blue/10 text-blue border border-blue/20",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[11px] font-medium",
        tones[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
