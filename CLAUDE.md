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

**Architecture v2 (decided 2026-05-25):** the homepage-focused page-at-once render pipeline is being replaced by a **component-by-component, whole-site migration pipeline**. The preview path is dropped; connected WP becomes a build precondition; one LLM call per unique block type produces a real Next.js component library (not an HTML blob); page composition is deterministic tree-walking. A mandatory pre-publish review screen with per-page fidelity scoring is non-negotiable in v1. **Read [`docs/saas-v2-component-pipeline.md`](docs/saas-v2-component-pipeline.md) for the architecture and [`docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md`](docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md) for the per-stage implementation roadmap.** v2 supersedes parts of `saas-mvp-transition.md` (Phases 2–3); the table at the top of the v2 doc lists exactly what's superseded vs. extended.

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

**packages/wp-plugin** is at **v0.7.0** (2026-06-01). v0.7.0 is the production-sync hardening release driven by the [2026-06-01 connector hardening plan](docs/2026-06-01-jab-wp-plugin-connector-hardening-plan.md):

- **v0.7.0** — `jab/get-<rest_base>` list abilities gain a real production-sync surface: `page` / `offset` + `orderby` (with an ID tiebreaker matching the primary direction for deterministic paging) + `order`, `modified_after|before` + `date_after|before` for incremental sync, and `include_ids` / `exclude_ids` / `slug_in` / `taxonomy` filters for known-set re-fetches (all capped at 100, auto-raising `numberposts` to the filter set size when omitted so "re-fetch these IDs" never silently truncates). Every row now carries REQUIRED `modified` + `modified_gmt` (**type-only breaking change** — `jab sync` regen). New `GET /wp-json/jab/v1/site` endpoint exposes identity, front-page mode, branding (icon + logo), nav menu locations, image sizes, active theme (default `edit_posts`, filterable via `jab/headless_kit/site_manifest_capability`). `/manifest` capability now filterable via `jab/headless_kit/manifest_capability` (default still `read` so the CLI's Application Password contract is preserved). Both filters mirror `Permissions::ability_capability()` — non-string / empty return resolves to `do_not_allow` rather than silently reverting to the default.
- **v0.6.3** — `BlockSchema::block_items_one_of()` emits `anyOf` instead of `oneOf` at the top-level discriminated union over block-type variants. WP REST's `rest_validate_value_from_schema` silently ignores `not` inside `oneOf` alternatives, so the fallback's `not: { enum: known_names }` exclusion was a no-op — every known block matched both its typed variant and the fallback, hard-failing every by-slug call with `include.blocks=true`.
- **v0.6.2** — Two silent bugs: (1) ACF schema transient cache key now includes plugin VERSION, so upgrades that change `to_field_schema()` emission no longer read back the prior version's stale schema; (2) `Registry::register_abilities()` no longer claims `name_single` in the collision pool (it's a derivation base, not an ability name) — was producing `jab/get-{cpt}-2-by-slug` on every CPT with `rest_base == slug`.
- **v0.6.1** — Relaxed output schemas: dropped `enum` from select/radio/checkbox (preserved under `x-acf-choices` vendor extension) and `format: uri/email/date` from url/email/date fields. Strict validation against drifted runtime data was hard-failing `jab/get-*` list calls. **Type-only breaking change** for SDK consumers.
- **v0.6.0** — Original typed-block moat: per-block-type discriminated unions from `WP_Block_Type_Registry`, ACF Block (`acf/*`) attribute enrichment via the extracted `AcfValueWalker`, `/wp-json/jab/v1/manifest` REST endpoint for the CLI's `jab sync` type generator.

See [`packages/wp-plugin/README.md`](packages/wp-plugin/README.md) for the full changelog. v0.5.0 (block-aware content emission), v0.4.0 (audit hardening), and v0.3.0 (schema correctness fixes) remain documented in the same README.

**v0.7.x roadmap (carried from the connector hardening plan):** Phase 1 (WordPress integration test harness — `wp-env` or `WP_PHPUnit` + the 9 known-regression conversions from `tests/README.md`) is the highest-leverage follow-up and the next plugin PR. Phase 5 (`wp jab doctor` + `/jab/v1/diagnostics`) becomes cheap once Phase 1 lands. Forms support, originally penciled for v0.7.0, now lands as a parallel track in v0.7.1+ per [`docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md`](docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md).

## Current state — where the two product tracks stand (snapshot 2026-05-27)

The original "Two Roads 10-day MVP" sprint shipped in May; both product tracks have moved past that framing. **Two Roads is now the continuous pilot-validation target** the plugin smokes and the SaaS v2 pipeline are built against — not a calendar sprint.

**Kit track — WP plugin + CLI + frontend template**

| Piece                                         | Status                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/wp-plugin`                          | **v0.7.0 shipped** (2026-06-01). Production sync hardening: new pagination / ordering / incremental-sync / ID-slug-taxonomy filter surface on every CPT-list ability; canonical `modified` / `modified_gmt` on every row (type-only breaking change); new `/wp-json/jab/v1/site` SiteManifest endpoint for SaaS onboarding + CLI scaffold; `/manifest` and `/site` capabilities both filterable. Full changelog in [`packages/wp-plugin/README.md`](packages/wp-plugin/README.md). |
| `packages/cli` (`@jab/wp-headless-cli` 0.1.0) | Consumes the v0.6.0 `/wp-json/jab/v1/manifest` endpoint. `scaffold` / `init` / `generate` / `sync` working end-to-end against the pilot. **Will need `jab sync` regen after upgrading consuming projects to v0.7.0** so the generated SDK picks up the new REQUIRED `modified` + `modified_gmt` row fields. |
| `packages/core` (`@jab/core` 0.1.0)           | MCP client extracted; carries the `McpClient` with configurable `timeoutMs` (added Stage 2 T1) that the SaaS depends on for slow ability calls on large WP installs.                                                                                                                                    |
| `packages/frontend-template` (0.1.0)          | Next.js starter the CLI emits. Stable.                                                                                                                                                                                                                                                                  |
| **Plugin v0.7.x — connector hardening**       | **In progress.** v0.7.0 (production sync + site manifest) shipped 2026-06-01. Next up: Phase 1 — real WordPress integration test harness (`wp-env` + `composer test:integration` + CI workflow + 9 known-regression conversions from `tests/README.md`). See [`docs/2026-06-01-jab-wp-plugin-connector-hardening-plan.md`](docs/2026-06-01-jab-wp-plugin-connector-hardening-plan.md). |
| **Plugin v0.7.x — Gravity Forms**             | **Design approved 2026-05-25** ([`docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md`](docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md)). Originally penciled for v0.7.0; now lands as a parallel track in v0.7.1+ (reads), v0.7.2+ (writes), v0.7.3+ (uploads). Sequenced after the connector hardening phases complete. |

**SaaS track — `apps/web` (`@jab/web` 0.0.0, pre-public)**

Implementing the v2 **component-by-component, whole-site migration pipeline** ([`docs/saas-v2-component-pipeline.md`](docs/saas-v2-component-pipeline.md)), against the [Stage 0–7 roadmap](docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md).

| Stage | Phase                                                                                                                                            | Status                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Prerequisites + teardown (drop preview path, land v2 schema, harden `connectWp`)                                                                 | **Shipped**                                                                                                                                                                                                                                                                                                             |
| 1     | Phase A — Discovery (Playwright capture, `block_inventory` / `page_inventory`, design tokens)                                                    | **Shipped** — validated against the Two Roads pilot smoke; surfaced the three v0.6.1–v0.6.3 plugin fixes.                                                                                                                                                                                                               |
| 2     | Phase B — Components (per-block-type LLM component generation, platform shims, persistence + cost telemetry, smoke runner)                       | **Shipped** ([`docs/superpowers/plans/2026-05-26-saas-v2-stage-2-component-pipeline.md`](docs/superpowers/plans/2026-05-26-saas-v2-stage-2-component-pipeline.md)). Output-quality bugs surfaced by Phase D smoke (9 categories) fixed in `worktree-phase-b-c-output-quality`; see [`docs/superpowers/specs/2026-05-28-phase-b-c-output-quality-followups.md`](docs/superpowers/specs/2026-05-28-phase-b-c-output-quality-followups.md). |
| 3     | Phase C — Compose & Shell (deterministic page composition from typed BlockNode tree)                                                             | **Shipped 2026-05-28** — 19-task TDD plan executed via subagent-driven-development; validated against Two Roads build `982f0d57` with all 28 required files in Storage. Header LLM compiled ok; footer fell back to deterministic (real fix in shell LLM cap bump 12KB → 24KB, commit `606837b`). Ships with compile gate (`JAB_COMPOSE_TYPECHECK=1` runs `tsc --noEmit` before deploy dispatch). Plan: [`docs/superpowers/plans/2026-05-27-saas-v2-phase-c-compose-shell.md`](docs/superpowers/plans/2026-05-27-saas-v2-phase-c-compose-shell.md). |
| 4     | Phase D — Build & Deploy (Vercel-managed deploy of Phase C output)                                                                              | **Shipped 2026-05-28** — `deploySite` Inngest worker, `VercelClient` REST wrapper, `pollDeployment`, `downloadProjectTree`, smoke runner, and operator runbook all landed. Phase D correctly dispatches → ensures Vercel project → syncs env vars → downloads project → deploys → polls → captures build log to Storage on failure → updates `site_builds`. Green smoke pending Phase B/C quality fixes merge. Spec: [`docs/superpowers/specs/2026-05-28-saas-v2-phase-d-build-deploy-design.md`](docs/superpowers/specs/2026-05-28-saas-v2-phase-d-build-deploy-design.md). |
| 5     | Phase E — Verify (output screenshots vs source, fidelity scoring)                                                                                | **Shipped 2026-06-03** — `verifyFidelity` Inngest worker, `playwright-verify` capture pass, `lib/ai/fidelity-score.ts` pixel-diff + vision stub. Builds reach `ready` only after fidelity rows are written; pages without source screenshots are recorded as skipped. Vision-LLM scoring is a stub that echoes the pixel score — real LLM call is a tracked Phase 7.1 follow-up. Plan: [`docs/superpowers/plans/2026-06-02-sass-mvp-completion-plan-app-only.md`](docs/superpowers/plans/2026-06-02-sass-mvp-completion-plan-app-only.md). |
| 6     | Phase F — Review + Publish gate (mandatory pre-publish review screen)                                                                            | **Shipped 2026-06-03** — `/projects/[id]/builds/[buildId]/review` lists every page with approve / approve-with-issues / reject; `evaluatePublishGate` enforces all-approved before `publishBuildAction` calls `VercelClient.requestPromote` and writes the production `deployments` row + the supersede sweep. Approval RPC migration 0023 enforces tenant-membership + column-level write restriction. |
| 7     | Orchestration + UX polish                                                                                                                        | **Shipped 2026-06-03** — `triggerBuildAction` is the single user-facing entry point to the pipeline; `discover-site` now dispatches `site/components.requested`; `markBuildFailed` shared helper covers all four workers; `/projects/[id]/builds/[buildId]/progress` reconstructs build state from the DB. Workspace targeted edits land via `workspace_edits` (migration 0024) + `edit-site` worker (clones artifacts + dispatches compose; guidance-driven regen is the Phase 7.1 follow-up). Project + dashboard UI now read real build / deploy state via `loadProjectBuildState`; `live = !!productionDeployment` replaces the hardcoded `false`. |

**Brand:** the JAB dark brand landed across the marketing + product surface in `apps/web` on 2026-05-24. Read [`docs/jab-brand.md`](docs/jab-brand.md) before touching any visual surface.

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
- ~~Adding form handling, search replacement, preview-mode wiring, multilingual, or WooCommerce support to v1.~~ **Revisited 2026-05-25:** form handling reopened — Gravity Forms first (planned for v0.7.x), with portability to WPForms / Forminator / Fluent Forms as a downstream goal via a normalized field-type taxonomy. See [`docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md`](docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md). The other items (search, preview-mode, multilingual, WooCommerce) stand.

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

~~Forms (Gravity Forms, WPForms),~~ WP search replacement, preview-mode wiring, multi-frontend support, hosted dashboard, Cursor support, WooCommerce integration, multilingual, membership plugins.

**Revisited 2026-05-25:** Forms reopened — Gravity Forms support is planned for v0.7.x (typed reads in v0.7.0, write path in v0.7.1, file uploads in v0.7.2), with portability to WPForms / Forminator / Fluent Forms as a downstream goal via a normalized JAB field-type taxonomy. Design doc: [`docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md`](docs/superpowers/plans/2026-05-25-wp-plugin-v0.7.0-forms-design.md). The rest of the list stands.

These are real future work — but every one of them obscures the v1 wedge if touched now.

## Coaching reminders (do not delete)

- The moat is the developer experience and the agency playbook — not the plugin code.
- The plugin should be boring. If it is interesting, it is probably wrong.
- The CLI generator's job is to make a dev's first ten minutes in Claude Code feel magical. Optimize for that.
- Two Roads is a test, not a launch. Resist scope creep.
