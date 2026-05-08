"use client";

import { useActionState } from "react";
import {
  probeAndSaveWpAction,
  type OnboardingActionState,
} from "@/lib/actions/onboarding";

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
        label="WordPress URL"
        hint="The base URL of the live site, e.g. https://client.example.com"
        defaultValue={defaultWpUrl}
        type="url"
        required
        autoComplete="url"
      />

      <Field
        id="wpUsername"
        label="WP admin username"
        hint="The username of an admin-capable user on the WP install."
        defaultValue={defaultUsername}
        type="text"
        required
        autoComplete="username"
      />

      <Field
        id="wpAppPassword"
        label="Application password"
        hint="Generate at WP Admin → Users → your user → Application Passwords. We store this encrypted (AES-256-GCM)."
        type="password"
        required
        autoComplete="new-password"
        // Spaces are visually-formatted by the WP UI but accepted by REST.
      />

      <details className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
        <summary className="cursor-pointer font-medium text-slate-700">
          Advanced — ability prefix
        </summary>
        <div className="mt-3">
          <Field
            id="abilityPrefix"
            label="Filter abilities by name prefix"
            hint="Default 'jab/' targets the current Jab plugin. Use 'skm/' for the pre-rebrand plugin, or leave blank to fetch all public abilities (e.g. WP core's 'wp/' prefix)."
            type="text"
            placeholder="jab/"
            defaultValue="jab/"
            autoComplete="off"
          />
        </div>
      </details>

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
        {pending ? "Probing WordPress…" : "Verify and continue"}
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
      <label
        htmlFor={id}
        className="block text-sm font-medium text-slate-700"
      >
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
