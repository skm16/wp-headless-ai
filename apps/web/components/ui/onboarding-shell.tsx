import { cn } from "@/lib/utils";
import { Stepper, type StepperStep } from "./stepper";

export interface OnboardingShellProps {
  children: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  steps: StepperStep[];
  /**
   * Optional right-rail content on `lg:` and up — used by the real
   * `/projects/[id]/onboard` route to show the saved /preview HTML as a
   * thumbnail while the user walks the wizard. Below `lg:` the aside
   * collapses below the wizard so step actions stay in thumb-reach.
   *
   * When omitted the shell renders the centered single-column layout
   * (today's default — used by the `/ui-kit/onboarding` demo and any
   * from-scratch project with no preview to show).
   */
  aside?: React.ReactNode;
  className?: string;
}

export function OnboardingShell({
  children,
  title,
  description,
  steps,
  aside,
  className,
}: OnboardingShellProps) {
  if (aside) {
    return (
      <div
        className={cn(
          "mx-auto w-full max-w-6xl px-6 py-8",
          className,
        )}
      >
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <div className="space-y-8">
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
          <aside className="lg:sticky lg:top-8 lg:self-start">{aside}</aside>
        </div>
      </div>
    );
  }

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
