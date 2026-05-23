import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * "Run locally" guide — shown on the project page once at least one
 * generation has succeeded. Walks the agency through clone → env →
 * dev → localhost:3000.
 *
 * Server Component (no "use client"): the steps are static, just rendered
 * with the project's actual repo + branch name interpolated in.
 *
 * Legacy notice: this surface predates the managed-hosting pivot. New Jab
 * projects deploy straight to `client.jabwp.app/{project-slug}/` and don't
 * need a local-dev step. Kept here because existing customers with
 * GitHub-tied projects depend on it.
 */
export function LocalDevGuide({
  githubRepoFullName,
  latestSucceededBranch,
}: {
  githubRepoFullName: string;
  latestSucceededBranch: string | null;
}) {
  const cloneUrl = `https://github.com/${githubRepoFullName}.git`;
  const branch = latestSucceededBranch ?? "<feature-branch>";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run locally</CardTitle>
        <p className="mt-1 text-sm text-slate-600">
          The most recent generation is on{" "}
          <span className="font-mono text-slate-900">{branch}</span>. Clone it
          and run <span className="font-mono">pnpm dev</span> to see the page
          rendered against your WordPress install.
        </p>
      </CardHeader>
      <CardBody className="space-y-5">
        <Alert tone="info">
          This is the pre-pivot local-dev flow. New projects on Jab&apos;s
          managed hosting skip this step — see the workspace demo at{" "}
          <code className="font-mono">/ui-kit/workspace</code> for the
          managed-hosting iteration loop.
        </Alert>

        <ol className="space-y-4">
          <Step n={1} title="Clone + check out the branch">
            <CodeBlock
              code={`git clone ${cloneUrl}\ncd ${repoFolderName(githubRepoFullName)}\ngit checkout ${branch}`}
            />
          </Step>

          <Step n={2} title="Set up env vars">
            <CodeBlock code="cp .env.example .env.local" />
            <p className="mt-2 text-xs text-slate-600">
              Then open{" "}
              <span className="font-mono">.env.local</span> and fill in:
            </p>
            <ul className="mt-1 ml-4 list-disc text-xs text-slate-600">
              <li>
                <span className="font-mono">WP_URL</span> — your WordPress base URL
              </li>
              <li>
                <span className="font-mono">WP_USER</span> — admin username
              </li>
              <li>
                <span className="font-mono">WP_APP_PASSWORD</span> — the
                application password from wp-admin
              </li>
              <li>
                For local-WP installs with self-signed certs (Local by Flywheel
                etc.), also uncomment{" "}
                <span className="font-mono">NODE_TLS_REJECT_UNAUTHORIZED=0</span>
              </li>
            </ul>
          </Step>

          <Step n={3} title="Install + start the dev server">
            <CodeBlock code={`pnpm install\npnpm dev`} />
            <p className="mt-2 text-xs text-slate-600">
              Or use <span className="font-mono">npm</span> /{" "}
              <span className="font-mono">yarn</span> if you prefer.
            </p>
          </Step>

          <Step n={4} title="Open the page">
            <p className="text-sm text-slate-700">
              Visit{" "}
              <a
                href="http://localhost:3000"
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-slate-900 underline-offset-2 hover:underline"
              >
                http://localhost:3000
              </a>
              {" "}— you should see the AI-generated homepage rendering against
              your real WordPress data.
            </p>
          </Step>
        </ol>

        <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          <strong className="text-slate-900">Heads up:</strong> the scaffold (
          <span className="font-mono">package.json</span>,{" "}
          <span className="font-mono">tsconfig.json</span>,{" "}
          <span className="font-mono">lib/sdk/</span>, etc.) lives on{" "}
          <span className="font-mono">main</span>. The feature branch you
          checked out adds <span className="font-mono">app/page.tsx</span> on
          top. Merge to <span className="font-mono">main</span> when you&apos;re
          happy with the page.
        </p>
      </CardBody>
    </Card>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-muted text-xs font-semibold text-brand-strong"
      >
        {n}
      </span>
      <div className="flex-1 space-y-2">
        <h3 className="text-sm font-medium text-slate-900">{title}</h3>
        {children}
      </div>
    </li>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-slate-900 px-3 py-2 text-xs leading-relaxed text-slate-100">
      <code>{code}</code>
    </pre>
  );
}

function repoFolderName(fullName: string): string {
  // "owner/repo" → "repo" (the dir git clone creates by default).
  const slash = fullName.lastIndexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}
