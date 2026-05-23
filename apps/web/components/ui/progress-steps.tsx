import { cn } from "@/lib/utils";
import { StatusDot } from "./status-dot";
import { CheckIcon, XIcon } from "./icons";

export type ProgressStepStatus = "pending" | "current" | "done" | "failed";

export interface ProgressStep {
  label: string;
  description?: string;
  status: ProgressStepStatus;
}

export interface ProgressStepsProps
  extends React.HTMLAttributes<HTMLOListElement> {
  steps: ProgressStep[];
}

export function ProgressSteps({
  steps,
  className,
  ...rest
}: ProgressStepsProps) {
  return (
    <ol className={cn("space-y-4", className)} {...rest}>
      {steps.map((step, idx) => (
        <li key={`${idx}-${step.label}`} className="flex items-start gap-3">
          <StepMark status={step.status} />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "text-sm font-medium",
                step.status === "current" && "text-slate-900",
                step.status === "done" && "text-slate-700",
                step.status === "pending" && "text-slate-400",
                step.status === "failed" && "text-danger-strong",
              )}
            >
              {step.label}
            </p>
            {step.description && (
              <p
                className={cn(
                  "mt-0.5 text-xs",
                  step.status === "pending"
                    ? "text-slate-400"
                    : "text-slate-500",
                )}
              >
                {step.description}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepMark({ status }: { status: ProgressStepStatus }) {
  if (status === "done") {
    return (
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success text-white"
        aria-label="Completed"
      >
        <CheckIcon />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-danger text-white"
        aria-label="Failed"
      >
        <XIcon />
      </span>
    );
  }
  if (status === "current") {
    return (
      <span
        className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center"
        aria-label="In progress"
      >
        <StatusDot tone="brand" pulse />
      </span>
    );
  }
  return (
    <span
      className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center"
      aria-label="Pending"
    >
      <span className="h-2 w-2 rounded-full bg-slate-300" />
    </span>
  );
}

