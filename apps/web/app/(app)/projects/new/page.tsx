import Link from "next/link";
import { createProject } from "@/lib/actions/projects";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

/**
 * New-project form. No JavaScript needed — it's a Server Component that
 * renders a `<form action={createProject}>` and lets Next.js dispatch the
 * server action via standard form submission.
 *
 * Validation lives in the server action (zod schema). v0 doesn't surface
 * field-level errors back to the form — `throw` in the action propagates
 * to the closest error boundary. Phase B accepts this trade-off; inline
 * error rendering lands when more fields do.
 *
 * Post-§12 this route is rarely used — most users land here via the
 * `/preview` wow path which promotes an anonymous draft into a project
 * on sign-up. This stays as the explicit "from scratch" affordance.
 */
export default function NewProjectPage() {
  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      <h1 className="font-display text-[28px] font-extrabold leading-[1.15] tracking-[-0.02em] text-wht">
        New project
      </h1>
      <p className="mt-1 text-sm text-gry">
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
          hint="The full URL of the WP site you're migrating. The onboarding wizard connects the plugin + app password after this."
        />
        <div className="flex items-center justify-end gap-2 pt-2">
          <Link href="/dashboard">
            <Button type="button" variant="ghost">
              Cancel
            </Button>
          </Link>
          <Button type="submit">Create project</Button>
        </div>
      </form>
    </div>
  );
}
