"use client";

import { useActionState } from "react";
import {
  saveGithubAction,
  type OnboardingActionState,
} from "@/lib/actions/onboarding";

/**
 * Step 2 — GitHub repo + fine-grained PAT.
 *
 * v0 design: agency creates an empty repo and a fine-grained PAT scoped to
 * just that repo (Contents: Read & Write, Metadata: Read). We don't validate
 * the PAT here — Phase D's worker is the first to actually push, and a
 * bad PAT will surface as a clear job failure with the offending repo
 * full-name in the message. Verifying here would require a live API call
 * burning a request the user might not need yet.
 */
export function GithubForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState<
    OnboardingActionState,
    FormData
  >(saveGithubAction, null);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="projectId" value={projectId} />

      <Field
        id="githubRepoFullName"
        label="GitHub repository"
        hint="Format: owner/repo. The repo should exist and be empty (or contain a default README only). The agency owns it."
        type="text"
        required
        placeholder="acme-agency/client-site-frontend"
        autoComplete="off"
      />

      <Field
        id="githubPat"
        label="Fine-grained personal access token"
        hint="Create at github.com → Settings → Developer settings → Fine-grained tokens. Scope to the single repo above with Contents: R/W and Metadata: R. Stored encrypted."
        type="password"
        required
        autoComplete="new-password"
      />

      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Saving…" : "Finish onboarding"}
      </button>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  ...inputProps
}: {
  id: string;
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        name={id}
        {...inputProps}
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
