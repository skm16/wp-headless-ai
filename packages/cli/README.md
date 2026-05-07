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

# Run it from anywhere — let pnpm wire up the bin
pnpm exec wpheadless init https://your-site.com \
  --user=your-wp-user \
  --password=xxxx-xxxx-xxxx-xxxx
```

This will:

1. Connect to `https://your-site.com/wp-json/mcp/mcp-adapter-default-server`
2. Call `mcp-adapter-discover-abilities` to enumerate every public ability
3. Call `mcp-adapter-get-ability-info` for each, capturing input/output JSON schemas
4. Write the result to `./.skm/manifest.json` in the current working directory

## Commands

### `wpheadless init <wp-url>`

Fetches the abilities manifest and stores it locally.

| Flag | Description | Default |
| --- | --- | --- |
| `--user <username>` | WordPress username | required |
| `--password <password>` | WordPress Application Password | required |
| `--output <dir>` | Where to write `.skm/manifest.json` | `.` (cwd) |

### `wpheadless generate [project-dir]`

Reads `<project-dir>/.skm/manifest.json` and emits a typed SDK to `<project-dir>/lib/sdk/`:

| File          | Purpose                                                    |
| ------------- | ---------------------------------------------------------- |
| `types.ts`    | One `<PascalName>Input` and `<PascalName>Output` per ability |
| `client.ts`   | Portable MCP HTTP client (zero runtime deps)               |
| `abilities.ts`| One typed function per ability                             |
| `index.ts`    | Barrel — `import { createClient, getPosts } from "@/lib/sdk"` |

### `wpheadless sync [project-dir]`

Re-runs `init` (using credentials saved in `.skm/config.json`) then `generate`. Use after content shape changes on the WP install.

> ⚠️ `.skm/config.json` carries plaintext credentials. The CLI auto-writes a `.skm/.gitignore` excluding it, but if you keep your `.skm/` outside the project root, ensure that location is also ignored.

## Development

```bash
pnpm --filter @skm/wp-headless-cli dev init https://your-site.com --user=... --password=...
pnpm --filter @skm/wp-headless-cli typecheck
```

`dev` uses `tsx` so source changes apply on the next run with no build step.
