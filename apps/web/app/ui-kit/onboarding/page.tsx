import { notFound } from "next/navigation";
import { OnboardingDemo } from "./onboarding-demo";

export const dynamic = "force-dynamic";

/**
 * Development-only demo of §12 steps 4 → 6 orchestrated through the
 * `OnboardingWizard`. Steps 1–3 (paste URL → public preview → signup) live
 * in the pre-auth `/preview` flow; by the time this wizard mounts the
 * project row already exists.
 *
 * Mock backend rejects suspiciously short app passwords. Submitting a
 * valid-looking one (20+ chars) shows the connected confirmation panel and
 * dumps the wizard's collected state for inspection.
 */
export default function OnboardingDemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <OnboardingDemo />;
}
