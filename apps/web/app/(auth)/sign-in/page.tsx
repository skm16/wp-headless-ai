import { Suspense } from "react";
import { SignInForm } from "./sign-in-form";

/**
 * Sign-in page wrapper. The form itself reads `?next=…` via useSearchParams,
 * which Next.js 15 requires inside a Suspense boundary so the rest of the
 * route can statically prerender. Without the boundary the build errors
 * with "missing-suspense-with-csr-bailout".
 */
export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="text-sm text-slate-500" aria-hidden="true">
          Loading…
        </div>
      }
    >
      <SignInForm />
    </Suspense>
  );
}
