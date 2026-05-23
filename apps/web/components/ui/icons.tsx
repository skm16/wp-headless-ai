import { cn } from "@/lib/utils";

/**
 * Shared icon components. All accept a `className` for sizing/color overrides
 * and default to `h-3.5 w-3.5 fill="currentColor"` aria-hidden. Consolidated
 * here so consumers don't drift on path data when re-implementing common
 * marks locally.
 */

interface IconProps {
  className?: string;
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg
      className={cn("h-3.5 w-3.5", className)}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M13.4 4.6a1 1 0 010 1.4l-6 6a1 1 0 01-1.4 0l-3-3a1 1 0 011.4-1.4L6.7 9.9l5.3-5.3a1 1 0 011.4 0z" />
    </svg>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <svg
      className={cn("h-3 w-3", className)}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg
      className={cn("h-3.5 w-3.5", className)}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="9" height="9" rx="1.5" />
      <path d="M11 4V3a1 1 0 00-1-1H3a1 1 0 00-1 1v7a1 1 0 001 1h1" />
    </svg>
  );
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg
      className={cn("h-3.5 w-3.5", className)}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M10 2h4v4M14 2l-7 7M11 8.5V13a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1h4.5" />
    </svg>
  );
}

export function InfoIcon({ className }: IconProps) {
  return (
    <svg
      className={cn("h-5 w-5", className)}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm-.75-9.25a.75.75 0 011.5 0v4.5a.75.75 0 01-1.5 0v-4.5zM10 6a.75.75 0 100 1.5A.75.75 0 0010 6z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function MobileIcon({ className }: IconProps) {
  return (
    <svg
      className={cn("h-3.5 w-3.5", className)}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="4.5" y="1.5" width="7" height="13" rx="1.5" />
      <line x1="7.5" y1="12" x2="8.5" y2="12" strokeLinecap="round" />
    </svg>
  );
}

export function TabletIcon({ className }: IconProps) {
  return (
    <svg
      className={cn("h-3.5 w-3.5", className)}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2.5" y="2" width="11" height="12" rx="1.5" />
      <line x1="7.5" y1="12" x2="8.5" y2="12" strokeLinecap="round" />
    </svg>
  );
}

export function DesktopIcon({ className }: IconProps) {
  return (
    <svg
      className={cn("h-3.5 w-3.5", className)}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <line x1="6" y1="14" x2="10" y2="14" strokeLinecap="round" />
      <line x1="8" y1="12" x2="8" y2="14" strokeLinecap="round" />
    </svg>
  );
}
