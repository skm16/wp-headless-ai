import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">wp-headless-kit pilot</h1>
        <p className="text-neutral-600">
          Typed SDK over the WordPress MCP Adapter. The example pages below pull live data from the
          configured WP install.
        </p>
      </header>

      <ul className="space-y-2 text-base">
        <li>
          <Link className="font-medium text-blue-600 hover:underline" href="/beers">
            /beers
          </Link>
          <span className="ml-2 text-sm text-neutral-500">
            beer catalog with ACF fields (abv, ibu, description, etc.)
          </span>
        </li>
      </ul>

      <section className="rounded border border-neutral-200 bg-white p-4 text-sm">
        <p className="font-medium text-neutral-700">Setup checklist</p>
        <ol className="mt-2 list-inside list-decimal space-y-1 text-neutral-600">
          <li>
            Copy <code className="rounded bg-neutral-100 px-1">.env.example</code> to{" "}
            <code className="rounded bg-neutral-100 px-1">.env.local</code> and fill in your WP
            credentials.
          </li>
          <li>
            From the monorepo root, run{" "}
            <code className="rounded bg-neutral-100 px-1">
              wpheadless init &lt;wp-url&gt; --user=… --password=… --output=packages/frontend-template
            </code>
            .
          </li>
          <li>
            Run{" "}
            <code className="rounded bg-neutral-100 px-1">
              wpheadless generate packages/frontend-template
            </code>{" "}
            to populate <code className="rounded bg-neutral-100 px-1">lib/sdk/</code>.
          </li>
          <li>
            <code className="rounded bg-neutral-100 px-1">pnpm dev</code> and visit{" "}
            <code className="rounded bg-neutral-100 px-1">/beers</code>.
          </li>
        </ol>
      </section>
    </div>
  );
}
