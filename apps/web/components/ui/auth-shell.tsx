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
        "flex min-h-screen flex-col items-center justify-center bg-surf px-4 py-12",
        className,
      )}
    >
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Link
            href="/"
            className="flex items-center gap-2.5 no-underline"
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect width="32" height="32" rx="7" fill="rgb(15 32 64)" stroke="rgb(26 49 88)" />
              <text x="4" y="23" fontFamily="var(--font-display), sans-serif" fontWeight="800" fontSize="18">
                <tspan fill="rgb(0 201 167)">J</tspan>
                <tspan fill="rgb(240 244 248)" opacity="0.22">›</tspan>
              </text>
            </svg>
            <span className="font-display text-2xl font-extrabold tracking-tight text-wht">
              JAB
            </span>
          </Link>
          {tagline && (
            <p className="mt-2 text-sm text-gry">{tagline}</p>
          )}
        </div>
        <div className="rounded-lg border border-bord bg-bg p-6">
          {children}
        </div>
      </div>
    </main>
  );
}
