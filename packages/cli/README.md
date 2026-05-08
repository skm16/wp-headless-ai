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
