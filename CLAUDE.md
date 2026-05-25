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
wp-headless-kit/                   # → renaming to "jab" once GH org rename lands
├── packages/
│   ├── wp-plugin/                 # PHP — the WordPress plugin (installed on client WP sites)
│   ├── core/                      # @jab/core — pure-function engine extracted Phase A
│   ├── cli/                       # @jab/wp-headless-cli — local-first CLI orchestrator over @jab/core
│   └── frontend-template/         # Next.js playground (not part of the published kit)
├── apps/
│   └── web/                       # @jab/web — managed headless platform SaaS (see docs/saas-mvp-transition.md)
├── pilots/
│   └── tworoads/                  # Two Roads Brewing pilot output (gitignored or private)
├── docs/
│   └── superpowers/plans/         # Per-feature implementation plans (jab-saas-v0/, etc.)
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

## The SaaS — apps/web (managed headless platform)

`apps/web` (`@jab/web`) is a **separate product track** from the three-layer kit above. It shares `@jab/core` and depends on the same WP plugin, but it is not the CLI and not a developer tool.

**What it is:** a managed headless platform. An agency connects a client's WordPress site and gets a fast, modern, **live hosted** frontend — AI does the build and the iteration, no developer required. The unit of value is a live, client-presentable site at a real URL, not a code artifact.

**Target customer:** small/medium marketing & web agencies that deliver WordPress sites and have no React/Next.js developers. **Pitch:** keep WP as the CMS the client already knows; the platform owns hosting, deploy, caching, and preview.

**Direction (decided 2026-05-23):** pivot from the original "code generator that pushes `app/page.tsx` to the agency's GitHub" to the managed platform above. The current `apps/web` code still reflects the old model — the transition is phased, with GitHub demoted to an opt-in export and monetization as per-site subscription. **Read [`docs/saas-mvp-transition.md`](docs/saas-mvp-transition.md) before doing any `apps/web` work** — it carries the phase plan and the prioritized SaaS audit findings.

**Brand (landed 2026-05-24):** the JAB dark brand (palette + Syne / DM Sans / JetBrains Mono + auth-aware marketing chrome + the Site Detail workspace) ships across the public marketing site and the authenticated product surface in `apps/web`. The old light-themed indigo placeholder is gone. **Read [`docs/jab-brand.md`](docs/jab-brand.md) before touching any visual surface in `apps/web`** — it carries the token table, typography rules (including the descender-clipping rule for Syne headlines), the "real data + mocked extras" pattern from the Site Detail page, and the explicit anti-patterns.

**Guardrail:** the kit's moat is still developer experience and the agency playbook. If SaaS work crowds out kit improvements, that is the failure mode to watch.

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

## Current plugin release

**packages/wp-plugin** is at **v0.6.0** (2026-05-25). 0.6.0 ships the typed-block moat: per-block-type discriminated unions derived from `WP_Block_Type_Registry`, ACF Block (`acf/*`) attribute enrichment via the extracted `AcfValueWalker`, and a `/wp-json/jab/v1/manifest` REST endpoint for the CLI's `jab sync` type generator. **Type-only breaking change** for SDK consumers — runtime JSON is unchanged. See [`packages/wp-plugin/README.md`](packages/wp-plugin/README.md) §What's new in 0.6.0 for the changelog and the carried-over v0.7+ deferral list. v0.5.0 (block-aware content emission), v0.4.0 (audit hardening), and v0.3.0 (schema correctness fixes) remain documented in the same README.

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
- ~~Adding a hosted dashboard or SaaS surface before two paying agency customers exist.~~ **Revisited 2026-05-08:** real customer-pull signal — SaaS work began under `apps/web/`. **Superseded 2026-05-23:** the SaaS is now a defined product track — a managed headless platform — see the `## The SaaS — apps/web` section above and [`docs/saas-mvp-transition.md`](docs/saas-mvp-transition.md). The `steady-frolicking-wind.md` v0 plan is retired. Original rule still holds as a reminder: the moat is developer experience, not dashboard chrome — if SaaS work crowds out kit improvements, that's the failure mode to watch.
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
