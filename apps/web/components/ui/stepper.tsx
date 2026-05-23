import { cn } from "@/lib/utils";
import { CheckIcon } from "./icons";

export type StepStatus = "pending" | "current" | "done";

export interface StepperStep {
  label: string;
  status: StepStatus;
}

export interface StepperProps extends React.HTMLAttributes<HTMLOListElement> {
  steps: StepperStep[];
}

export function Stepper({ steps, className, ...rest }: StepperProps) {
  return (
    <ol
      className={cn("flex items-center gap-3 text-sm", className)}
      aria-label="Progress"
      {...rest}
    >
      {steps.map((step, idx) => (
        <li key={`${idx}-${step.label}`} className="flex items-center gap-3">
          <StepBadge index={idx + 1} status={step.status} />
          <span
            className={cn(
              "font-medium",
              step.status === "current" && "text-slate-900",
              step.status === "done" && "text-slate-700",
              step.status === "pending" && "text-slate-400",
            )}
          >
            {step.label}
          </span>
          {idx < steps.length - 1 && (
            <span
              aria-hidden="true"
              className="h-px w-6 bg-slate-200"
            />
          )}
        </li>
      ))}
    </ol>
  );
}

function StepBadge({ index, status }: { index: number; status: StepStatus }) {
  const base =
    "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold";
  if (status === "done") {
    return (
      <span
        className={cn(base, "bg-success text-white")}
        aria-current={undefined}
      >
        <CheckIcon className="h-4 w-4" />
      </span>
    );
  }
  if (status === "current") {
    return (
      <span
        className={cn(base, "bg-slate-900 text-white")}
        aria-current="step"
      >
        {index}
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-slate-100 text-slate-500")}>{index}</span>
  );
}

