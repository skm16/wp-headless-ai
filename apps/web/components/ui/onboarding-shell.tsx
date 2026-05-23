import { cn } from "@/lib/utils";
import { Stepper, type StepperStep } from "./stepper";

export interface OnboardingShellProps {
  children: React.ReactNode;
  title: string;
  description?: string;
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
    <div className={cn("mx-auto w-full max-w-2xl space-y-8", className)}>
      <header className="space-y-3">
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {description && (
          <p className="text-sm text-slate-600">{description}</p>
        )}
        <Stepper steps={steps} className="pt-2" />
      </header>

      <div>{children}</div>
    </div>
  );
}
