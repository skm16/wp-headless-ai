import { AuthShell } from "@/components/ui/auth-shell";

/**
 * (auth) route-group layout — wraps sign-in, sign-up, and any future auth-
 * related public pages (forgot-password, magic-link verify, etc.). Chrome
 * lives in AuthShell so the layout stays a thin orchestrator. Distinct from
 * (app)/layout.tsx which carries the signed-in chrome.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthShell tagline="Modern frontends for the WordPress sites you already build.">
      {children}
    </AuthShell>
  );
}
