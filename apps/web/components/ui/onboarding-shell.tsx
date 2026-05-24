import { cn } from "@/lib/utils";
import { Stepper, type StepperStep } from "./stepper";

export interface OnboardingShellProps {
  children: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  steps: StepperStep[];
  className?: string;
}

export function OnboardingShell({
  children,
  title,
  description,
  steps,
  className,
}: OnboardingShellProps) {
  return (
    <div className={cn("mx-auto w-full max-w-2xl space-y-8 px-6 py-8", className)}>
      <header className="space-y-3">
        <h1 className="font-display text-[28px] font-extrabold leading-[1.15] tracking-[-0.02em] text-wht">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-gry">{description}</p>
        )}
        <Stepper steps={steps} className="pt-2" />
      </header>

      <div>{children}</div>
    </div>
  );
}
