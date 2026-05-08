import Link from "next/link";
import { createProject } from "@/lib/actions/projects";

/**
 * New-project form. No JavaScript needed — it's a Server Component that
 * renders a `<form action={createProject}>` and lets Next.js dispatch the
 * server action via standard form submission.
 *
 * Validation lives in the server action (zod schema). v0 doesn't surface
 * field-level errors back to the form — `throw` in the action propagates
 * to the closest error boundary. Phase B accepts this trade-off; Phase C
 * may add inline error rendering when more fields land.
 */
export default function NewProjectPage() {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-bold text-slate-900">New project</h1>
      <p className="mt-1 text-sm text-slate-600">
        Each project pairs Jab with one WordPress site. You can rename the
        client and WP URL later.
      </p>

      <form action={createProject} className="mt-8 space-y-5">
        <Field
          label="Project name"
          name="name"
          placeholder="acme-website"
          autoComplete="off"
          required
          maxLength={100}
        />
        <Field
          label="Client name"
          name="clientName"
          placeholder="Acme Inc."
          autoComplete="organization"
          required
          maxLength={100}
        />
        <Field
          label="WordPress URL"
          name="wpUrl"
          type="url"
          placeholder="https://acme.com"
          autoComplete="url"
          required
          help="The full URL of the WP site you're migrating. We'll connect to it during onboarding (Phase C)."
        />
        <div className="flex items-center justify-end gap-3 pt-2">
          <Link
            href="/dashboard"
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Create project
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  help,
  ...inputProps
}: {
  label: string;
  help?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={inputProps.name} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={inputProps.name}
        {...inputProps}
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      {help && <p className="mt-1 text-xs text-slate-500">{help}</p>}
    </div>
  );
}
