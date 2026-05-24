"use client";

import { useActionState } from "react";
import {
  probeAndSaveWpAction,
  type OnboardingActionState,
} from "@/lib/actions/onboarding";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

/**
 * Step 1 — WP credentials + probe.
 *
 * The form submits the application password in cleartext over HTTPS to our
 * server action, which encrypts it with AES-256-GCM before persisting. The
 * action ALSO probes the WP install via @jab/core's MCP-based fetchManifest
 * before committing anything, so a typoed password leaves the project's
 * stored state untouched.
 */
export function WpCredsForm({
  projectId,
  defaultWpUrl,
  defaultUsername,
}: {
  projectId: string;
  defaultWpUrl: string;
  defaultUsername: string;
}) {
  const [state, formAction, pending] = useActionState<
    OnboardingActionState,
    FormData
  >(probeAndSaveWpAction, null);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="projectId" value={projectId} />

      <Field
        id="wpUrl"
        name="wpUrl"
        label="WordPress URL"
        hint="The base URL of the live site, e.g. https://client.example.com"
        defaultValue={defaultWpUrl}
        type="url"
        required
        autoComplete="url"
      />

      <Field
        id="wpUsername"
        name="wpUsername"
        label="WordPress admin username"
        hint="An admin-capable user on the WP install — usually the email you log into wp-admin with."
        defaultValue={defaultUsername}
        type="text"
        required
        autoComplete="username"
      />

      <Field
        id="wpAppPassword"
        name="wpAppPassword"
        label="Application password"
        hint="Generate at wp-admin → Users → your user → Application Passwords. We store this encrypted (AES-256-GCM)."
        type="password"
        required
        autoComplete="new-password"
      />

      <details className="rounded-md border border-bord bg-surf p-3 text-sm">
        <summary className="cursor-pointer font-medium text-gry">
          Advanced — ability prefix
        </summary>
        <div className="mt-3">
          <Field
            id="abilityPrefix"
            name="abilityPrefix"
            label="Filter abilities by name prefix"
            hint="Default 'jab/' targets the current Jab plugin. Use 'skm/' for the pre-rebrand plugin, or leave blank to fetch all public abilities (e.g. WP core's 'wp/' prefix)."
            type="text"
            placeholder="jab/"
            defaultValue="jab/"
            autoComplete="off"
          />
        </div>
      </details>

      {state?.error && <Alert tone="danger">{state.error}</Alert>}

      <Button
        type="submit"
        className="w-full"
        loading={pending}
        loadingText="Probing WordPress…"
      >
        Verify and continue
      </Button>
    </form>
  );
}
