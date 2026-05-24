import { Suspense } from "react";
import { SignInForm } from "@/app/(auth)/sign-in/sign-in-form";

/**
 * Sign-up page wrapper. Reuses SignInForm with initialMode="sign-up" so the
 * landing CTA defaults to account creation. The form's internal toggle still
 * lets visitors switch to sign-in without leaving the page. Suspense boundary
 * exists for the same reason as /sign-in — the form reads ?next via
 * useSearchParams.
 */
export default function SignUpPage() {
  return (
    <Suspense
      fallback={
        <div className="text-sm text-gry-d" aria-hidden="true">
          Loading…
        </div>
      }
    >
      <SignInForm initialMode="sign-up" />
    </Suspense>
  );
}
