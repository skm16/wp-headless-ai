import { cn } from "@/lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-bord bg-bg/40 px-6 py-12 text-center",
        className,
      )}
      {...rest}
    >
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-elev text-teal">
          {icon}
        </div>
      )}
      <h3 className="text-base font-bold leading-snug text-wht">
        {title}
      </h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-gry">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
