# @skm/wp-headless-cli

CLI generator that turns a WordPress site (with the `wp-headless-kit` plugin installed) into a typed Next.js project for AI-iterable headless development.

> **v0.1.0 — `init` only.** `generate` and `sync` land in subsequent versions.

## Requirements

- Node **20+** (uses native `fetch`)
- A WordPress install running [`wp-headless-kit`](../wp-plugin/) with at least one ability marked `meta.mcp.public => true`
- A WordPress [Application Password](https://wordpress.org/documentation/article/application-passwords/) for an authenticated user

## Quick start

```bash
# From the monorepo root
pnpm install

# Build the CLI (compiles src/ → dist/)
pnpm --filter @skm/wp-headless-cli build

# One-time: link the CLI globally so `wpheadless` is on your PATH
pnpm setup                                   # creates ~/AppData/Local/pnpm and adds to PATH
pnpm --dir packages/cli link --global        # symlinks the bin

# Use it from anywhere
wpheadless init https://your-site.com \
  --user=your-wp-user \
  --password=xxxx-xxxx-xxxx-xxxx
```

> After `pnpm setup`, **open a new terminal** so the PATH change takes effect before running `link --global`.

This will:

1. Connect to `https://your-site.com/wp-json/mcp/mcp-adapter-default-server`
2. Call `mcp-adapter-discover-abilities` to enumerate every public ability
3. Call `mcp-adapter-get-ability-info` for each, capturing input/output JSON schemas
4. Write `./.skm/manifest.json` and `./.skm/config.json` (gitignored — credentials saved for `sync`)
5. **On first run**, bootstrap the project's hand-crafted glue layer:
   - `lib/skm/client.ts` — server-only env-driven SDK client wrapper
   - `.env.example` — sample env vars to copy to `.env.local`

Bootstrap is **idempotent**: if either file already exists it's left untouched. Re-running `init` (or running `sync` afterward) never clobbers edits you've made to the glue layer.

## Commands

### `wpheadless scaffold <project-name>`

Bootstrap a fresh Next.js project pre-wired to a WordPress headless backend in one command. Wraps `npx create-next-app@latest` with our opinionated flags (TypeScript + App Router + Tailwind, no ESLint, `@/*` import alias) then runs `init` + `generate` against the new project.

```bash
wpheadless scaffold my-client-site \
  --wp-url=https://client-site.com \
  --user=admin
# Password prompted (masked stdin); never put it on the CLI flag in production.

cd my-client-site
pnpm dev
```

| Flag | Description | Default |
| --- | --- | --- |
| `--wp-url <url>` | Target WP site URL | prompted if omitted |
| `--user <username>` | WP username | prompted if omitted |
| `--password <password>` | Application Password (warns about shell history) | prompted; also reads `WP_APP_PASSWORD` env var |
| `--package-manager <pm>` | `pnpm` \| `npm` \| `yarn` \| `bun` | auto-detected, falls back to pnpm |
| `--no-env-local` | Skip writing `.env.local` even when creds are available | off (it writes by default) |
| `--insecure` | Disable TLS verification (auto-on for `.local`/`.test`) | off |

What scaffold writes (10 minutes of manual setup → 30 seconds):

- The full Next.js project skeleton via `create-next-app`
- `.skm/manifest.json` + `.skm/config.json` (gitignored)
- `lib/sdk/{types,client,abilities,index,CLAUDE.md}` — the typed SDK
- `lib/skm/client.ts` — the server-only env-driven SDK wrapper
- `.env.example` — sample env vars
- `.env.local` — your actual credentials (Next.js gitignores this; never commit)

If `create-next-app` succeeds but `init`/`generate` fails (bad creds, wrong WP URL, etc.), the project directory is left in place with the partial state — the error message tells you the exact `wpheadless init` command to retry inside the project.

#### Strangler-fig migration

Scaffolded projects ship with `next.config.ts` wired to proxy any unmatched route to a `WP_PROXY_URL` env var. This is the **incremental migration** path for agencies who want to take an existing client site headless without rebuilding from scratch:

```bash
# in .env.local
WP_PROXY_URL=https://existing-client-site.com
```

Now `pnpm dev` boots a Next.js app where every route looks identical to the original site (because every route is being proxied through). Replace one route at a time — your `app/posts/page.tsx` immediately wins over the proxied `/posts`; everything else continues to fall through to the original. The classic "strangler fig" pattern. Leave `WP_PROXY_URL` empty to disable.

### `wpheadless init <wp-url>`

Fetches the abilities manifest and stores it locally.

| Flag | Description | Default |
| --- | --- | --- |
| `--user <username>` | WordPress username | required |
| `--password <password>` | WordPress Application Password | required |
| `--output <dir>` | Where to write `.skm/manifest.json` | `.` (cwd) |
| `--prefix <prefix>` | Only include abilities whose name starts with this prefix | `skm/` |
| `--insecure` | Disable TLS verification (auto-on for `.local` / `.test` hosts) | off |

### Local dev TLS

LocalWP / Valet / DDEV serve sites at `*.local` or `*.test` with self-signed certs that don't validate. The CLI detects these hostnames and disables TLS verification for the run automatically — no env var needed. A one-line warning prints when this kicks in. For other self-signed scenarios (private CA on staging, etc.) pass `--insecure` explicitly.

### `wpheadless generate [project-dir]`

Reads `<project-dir>/.skm/manifest.json` and emits a typed SDK to `<project-dir>/lib/sdk/`:

| File          | Purpose                                                    |
| ------------- | ---------------------------------------------------------- |
| `types.ts`    | One `<PascalName>Input` and `<PascalName>Output` per ability |
| `client.ts`   | Portable MCP HTTP client (zero runtime deps)               |
| `abilities.ts`| One typed function per ability                             |
| `index.ts`    | Barrel — `import { createClient, getPosts } from "@/lib/sdk"` |
| `CLAUDE.md`   | SDK reference for Claude Code (function table + patterns)  |

The emitted `lib/sdk/CLAUDE.md` is auto-loaded by Claude Code when working in `lib/sdk/` and can be referenced from the project's root `CLAUDE.md` to give the agent full context on the available abilities without having to read `types.ts`.

### `wpheadless sync [project-dir]`

Re-runs `init` (using credentials saved in `.skm/config.json`) then `generate`. Use after content shape changes on the WP install.

> ⚠️ `.skm/config.json` carries plaintext credentials. The CLI auto-writes a `.skm/.gitignore` excluding it, but if you keep your `.skm/` outside the project root, ensure that location is also ignored.

## Development

```bash
pnpm --filter @skm/wp-headless-cli dev init https://your-site.com --user=... --password=...
pnpm --filter @skm/wp-headless-cli typecheck
```

`dev` uses `tsx` so source changes apply on the next run with no build step.
