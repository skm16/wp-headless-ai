# wp-headless-kit

> A WordPress-to-Claude-Code headless toolkit. Convert traditional WP sites into AI-iterable headless frontends using WordPress core's official Abilities API + MCP Adapter, paired with an opinionated CLI generator and Claude Code-native developer experience.
>
> _Project name is a placeholder — rename to your final brand (e.g., `jab-headless`, `studio-forge`) before public launch._

## Project goal

Make it trivial for an agency to:

1. Drop a thin WordPress plugin onto a client's WP install.
2. Run a single CLI command locally.
3. Get a Next.js project pre-wired to Claude Code — typed SDK, MCP integration, opinionated skills — ready to vibe-code against the live WP backend.

**Strategic positioning:** don't out-engineer Automattic on the protocol layer. Out-deliver them on the agency-facing developer experience.

## Repository structure (monorepo)

```
wp-headless-kit/
├── packages/
│   ├── wp-plugin/             # PHP — the WordPress plugin
│   ├── cli/                   # TypeScript — the CLI generator
│   └── frontend-template/     # Next.js — the starter project that gets emitted
├── pilots/
│   └── tworoads/              # Two Roads Brewing pilot output (gitignored or private)
├── docs/
└── CLAUDE.md
```

## Architecture — three layers

### Layer 1 — WP plugin (thin)

- Composer-installable, depends on `wordpress/mcp-adapter`.
- Registers 8–12 opinionated abilities for content fetching: posts, CPTs, ACF field groups, menus, options, taxonomies.
- Auto-generates JSON Schema from ACF field group definitions where possible.
- Marks all public abilities with `meta.mcp.public => true` so they flow through the default MCP server.
- Exposes a `/wp-json/jab/v1/manifest` REST endpoint returning derived TypeScript-ready schemas the CLI consumes.

### Layer 2 — CLI generator

- Node 20+, TypeScript, pnpm.
- `jab init <wp-url> --token=<app-password>` → fetch manifest, validate connection, write a local config.
- `jab generate --output ./my-site` → emit a Next.js project from the frontend-template, with types and SDK derived from the manifest.
- `jab sync` → re-pull schema, regenerate types only, leave app code untouched.

### Layer 3 — Generated Next.js project

- Next.js App Router, TypeScript, Tailwind.
- `lib/sdk/` — typed hooks and clients generated from JSON Schemas.
- `CLAUDE.md` — project context for the agency dev's Claude Code session.
- `.claude/skills/` — opinionated workflows (`add-content-section`, `query-wp-content`, `migrate-theme-component`).
- `.claude/mcp.json` — MCP client config wired to the WP plugin via `@automattic/mcp-wordpress-remote`.
- `llms.txt` — generic AI-context standard for non-Claude tools.
- Default scaffold components, one per content type. Devs are expected to delete or rewrite these — they are starting points, not finished UI.

## Tech stack

| Layer             | Stack                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| WP Plugin         | PHP 7.4+, Composer, Jetpack Autoloader, `wordpress/mcp-adapter`, `wordpress/abilities-api` (in core since WP 6.9). |
| CLI               | Node 20+, TypeScript, pnpm, `commander` (or `clipanion`).                                                          |
| Frontend Template | Next.js 15+ App Router, TypeScript, Tailwind, ISR by default.                                                      |
| Auth              | WordPress Application Passwords.                                                                                   |
| Transport         | HTTP via `@automattic/mcp-wordpress-remote` proxy (stdio bridge for Claude Code).                                  |

## Canonical external references

- WordPress MCP Adapter — `https://github.com/WordPress/mcp-adapter` (do not reinvent any of this).
- WordPress Abilities API — `https://make.wordpress.org/core/2025/11/10/abilities-api-in-wordpress-6-9/`.
- Automattic MCP WordPress Remote proxy — `@automattic/mcp-wordpress-remote` on npm.
- MCP Specification — `https://modelcontextprotocol.io/specification/2025-06-18/`.

## Current sprint — Two Roads pilot (10-day MVP)

| Day | Focus                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------- |
| 1   | WP plugin scaffold + Composer setup + one verified ability.                                                 |
| 2   | Plugin: 8–12 abilities covering Two Roads content (posts, beers CPT, events, menu, ACF groups).             |
| 3   | CLI generator v0: pull manifest, emit TS types.                                                             |
| 4   | CLI generator: emit `CLAUDE.md`, skills, MCP config, project starter.                                       |
| 5   | Install on Two Roads staging WP, run generator end-to-end, verify Claude Code talks to the backend.         |
| 6–8 | Rebuild Two Roads homepage in Claude Code using only the generated project. Patch generator as gaps appear. |
| 9   | Polish, screenshots, deploy preview to Vercel.                                                              |
| 10  | Loom recording for Label Interactive demo.                                                                  |

## Conventions and patterns

- **WP plugin stays thin.** If we are writing transport, error handling, observability, JSON-RPC, or session code, we are doing it wrong — that is `wordpress/mcp-adapter`'s job.
- **CLI generator is opinionated.** One happy path: Next.js App Router + TypeScript + Tailwind. Don't try to support every framework in v1.
- **Generated artifacts are regenerable.** Devs never edit generated files. Schema changes → regenerate SDK → existing app code is type-checked against the new shape.
- **Namespacing.** All ability names use the `jab/` prefix (e.g., `jab/get-posts`, `jab/get-beers`). REST routes use `jab/v1/*`.
- **Errors are loud.** During the pilot, no swallowed errors. Every failure produces a clear message that explains how to fix it.
- **Auth is Application Passwords.** No custom auth schemes in v1.

## Anti-patterns to avoid

- Building MCP transport, error handling, or observability ourselves.
- Trying to support Cursor + other AI tools in v1 — Claude Code only.
- Generating components that are too complete — devs will rewrite them, so generate scaffolds, not finished UI.
- Letting the plugin grow to handle business logic — the plugin's job is content exposure, not transformation.
- Adding a hosted dashboard or SaaS surface before two paying agency customers exist.
- Adding form handling, search replacement, preview-mode wiring, multilingual, or WooCommerce support to v1.

## Working with Claude Code in this repo

Point a new Claude Code session at this `CLAUDE.md` before doing anything else.

Skills to add under `.claude/skills/` as needs emerge:

- `register-ability` — how to add a new WP ability to the plugin.
- `extend-generator` — how to add a new emitter to the CLI.
- `debug-mcp-connection` — checklist when MCP can't reach the WP backend.

Subagents to define in `.claude/agents/` once the codebase has shape:

- `wp-plugin-dev` — focused on the PHP plugin, knows Abilities API + MCP Adapter intimately.
- `cli-dev` — focused on the TypeScript CLI generator.
- `frontend-dev` — focused on the Next.js template and dev-experience polish.

## Out of scope for v1 (deliberately)

Forms (Gravity Forms, WPForms), WP search replacement, preview-mode wiring, multi-frontend support, hosted dashboard, Cursor support, WooCommerce integration, multilingual, membership plugins.

These are real future work — but every one of them obscures the v1 wedge if touched now.

## Coaching reminders (do not delete)

- The moat is the developer experience and the agency playbook — not the plugin code.
- The plugin should be boring. If it is interesting, it is probably wrong.
- The CLI generator's job is to make a dev's first ten minutes in Claude Code feel magical. Optimize for that.
- Two Roads is a test, not a launch. Resist scope creep.
