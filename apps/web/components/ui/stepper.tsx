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
              step.status === "current" && "text-wht",
              step.status === "done" && "text-gry",
              step.status === "pending" && "text-gry-d",
            )}
          >
            {step.label}
          </span>
          {idx < steps.length - 1 && (
            <span
              aria-hidden="true"
              className="h-px w-6 bg-bord"
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
        className={cn(base, "bg-teal text-bg")}
        aria-current={undefined}
      >
        <CheckIcon className="h-4 w-4" />
      </span>
    );
  }
  if (status === "current") {
    return (
      <span
        className={cn(base, "bg-teal/15 text-teal ring-1 ring-teal/30")}
        aria-current="step"
      >
        {index}
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-elev text-gry-d")}>{index}</span>
  );
}
