# wp-headless-kit

A WordPress-to-Claude-Code headless toolkit. Convert traditional WordPress sites into AI-iterable headless frontends using WordPress core's official Abilities API and the `wordpress/mcp-adapter`, paired with an opinionated CLI generator and a Claude Code-native developer experience.

The repository also hosts the managed SaaS track (`apps/web`, `@jab/web`) — a hosted platform for agencies who want the headless frontend without writing or owning code. Current architecture: [`docs/saas-v2-component-pipeline.md`](./docs/saas-v2-component-pipeline.md) (component-by-component, whole-site migration pipeline; Stage 2 Phase B in flight as of 2026-05-27).

> Project name is a placeholder — see [`CLAUDE.md`](./CLAUDE.md) for context.

## Repository layout

```
wp-headless-kit/
├── packages/
│   ├── wp-plugin/             # PHP — the WordPress plugin (v0.6.3 — typed-block moat + /wp-json/jab/v1/manifest)
│   ├── core/                  # @jab/core — pure-function engine (MCP client + SDK primitives)
│   ├── cli/                   # @jab/wp-headless-cli — local-first CLI (v0.6.x plugin manifest consumer)
│   └── frontend-template/     # Next.js playground (not published)
├── apps/
│   └── web/                   # @jab/web — managed headless platform SaaS (SaaS v2 component pipeline — Stage 2 Phase B in flight)
├── pilots/
│   └── tworoads/              # Pilot output (gitignored)
├── docs/
│   ├── saas-v2-component-pipeline.md  # CURRENT SaaS architecture (component pipeline, supersedes parts of saas-mvp-transition.md)
│   ├── saas-mvp-transition.md         # Original SaaS pivot decision + content model + Phase 0/1 audit findings
│   ├── jab-brand.md                   # JAB dark brand system (palette, typography, tokens, anti-patterns)
│   ├── ai-prompt-modes.md             # Fidelity intents (Faithful / Refresh / Reimagine) inputs + behavior
│   ├── hosting.md                     # Hosting decision (Vercel for MVP, Cloudflare scale target)
│   ├── saas-failure-states.md         # User-facing failure copy catalog
│   ├── concierge-runbook.md           # Operator playbook for the Phase 0 concierge motion
│   └── superpowers/plans/             # Per-feature implementation plans (saas-v2 roadmap + stage plans, plugin v0.7.x forms design, etc.)
└── CLAUDE.md
```

## Where to start

Read [`CLAUDE.md`](./CLAUDE.md) — it has the architecture, current plugin release notes, conventions, and anti-patterns. Every contributor (human or AI) should load that file first.

For the SaaS track:

- [`docs/saas-v2-component-pipeline.md`](./docs/saas-v2-component-pipeline.md) — **current** SaaS architecture: six-phase component-by-component migration pipeline keyed off the v0.6.0 plugin's typed `BlockNode[]`. Supersedes Phases 2–3 of `saas-mvp-transition.md`. Read this first for any `apps/web` work.
- [`docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md`](./docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md) — per-stage implementation roadmap (Stages 0–7) the v2 pipeline is being built against.
- [`docs/saas-mvp-transition.md`](./docs/saas-mvp-transition.md) — original SaaS pivot decision (2026-05-23) + content-ownership model. Still authoritative for Phase 0/1 framing and the operator concierge motion; v2 has superseded its Phase 2/3 implementation plan.
- [`docs/jab-brand.md`](./docs/jab-brand.md) — JAB dark brand system: palette, typography, tokens, conventions, the Site Detail "real data + mocked extras" pattern, anti-patterns. Read before any visual work in `apps/web`.
- [`docs/hosting.md`](./docs/hosting.md) — Vercel-for-MVP decision and the provider-seam requirement for the eventual Cloudflare migration.
- [`docs/saas-failure-states.md`](./docs/saas-failure-states.md) — user-facing copy for every failure path the engineering audit surfaced.
- [`docs/concierge-runbook.md`](./docs/concierge-runbook.md) — the Phase 0 motion an operator uses while the hosting layer is being built.

For package-specific docs:

- [`packages/wp-plugin/README.md`](./packages/wp-plugin/README.md) — installable WP plugin (abilities, ACF mapping, audit closure).
- [`packages/cli/README.md`](./packages/cli/README.md) — `jab scaffold` / `init` / `generate` / `sync`.
- [`packages/frontend-template/README.md`](./packages/frontend-template/README.md) — the Next.js starter the CLI emits.
