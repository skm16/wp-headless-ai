import Link from "next/link";
import { cn } from "@/lib/utils";

export interface AuthShellProps {
  children: React.ReactNode;
  tagline?: string;
  className?: string;
}

export function AuthShell({
  children,
  tagline,
  className,
}: AuthShellProps) {
  return (
    <main
      className={cn(
        "flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12",
        className,
      )}
    >
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="text-3xl font-extrabold tracking-tight text-slate-900"
          >
            Jab
          </Link>
          {tagline && (
            <p className="mt-1 text-sm text-slate-600">{tagline}</p>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}
