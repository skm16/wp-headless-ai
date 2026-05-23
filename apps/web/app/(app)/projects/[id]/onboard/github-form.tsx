"use client";

import { useActionState } from "react";
import {
  saveGithubAction,
  type OnboardingActionState,
} from "@/lib/actions/onboarding";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

/**
 * Step 2 — GitHub repo + fine-grained PAT.
 *
 * v0 design: agency creates an empty repo and a fine-grained PAT scoped to
 * just that repo (Contents: Read & Write, Metadata: Read). We don't validate
 * the PAT here — the worker is the first to actually push, and a bad PAT
 * will surface as a clear job failure with the offending repo full-name in
 * the message. Verifying here would require a live API call burning a
 * request the user might not need yet.
 *
 * Legacy notice: per the SaaS pivot, GitHub export is being demoted to an
 * opt-in surface. New projects should land in the managed-hosting flow
 * instead — the banner at the top of this form flags that to anyone who
 * arrives here via the existing onboarding route.
 */
export function GithubForm({ projectId }: { projectId: string }) {
  const [state, formAction, pending] = useActionState<
    OnboardingActionState,
    FormData
  >(saveGithubAction, null);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="projectId" value={projectId} />

      <Alert tone="info" title="Legacy GitHub export">
        New Jab projects ship to managed hosting at{" "}
        <code className="font-mono">client.jabwp.app</code> — no GitHub repo
        required. This step still works for projects that started before the
        pivot; future projects skip it.
      </Alert>

      <Field
        id="githubRepoFullName"
        name="githubRepoFullName"
        label="GitHub repository"
        hint="Format: owner/repo. The repo should exist and be empty (or contain a default README only). The agency owns it."
        type="text"
        required
        placeholder="acme-agency/client-site-frontend"
        autoComplete="off"
      />

      <Field
        id="githubPat"
        name="githubPat"
        label="Fine-grained personal access token"
        hint="Create at github.com → Settings → Developer settings → Fine-grained tokens. Scope to the single repo above with Contents: R/W and Metadata: R. Stored encrypted."
        type="password"
        required
        autoComplete="new-password"
      />

      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <Button
        type="submit"
        className="w-full"
        loading={pending}
        loadingText="Saving…"
      >
        Finish onboarding
      </Button>
    </form>
  );
}
