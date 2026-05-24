# wp-headless-kit

A WordPress-to-Claude-Code headless toolkit. Convert traditional WordPress sites into AI-iterable headless frontends using WordPress core's official Abilities API and the `wordpress/mcp-adapter`, paired with an opinionated CLI generator and a Claude Code-native developer experience.

The repository also hosts the managed SaaS track (`apps/web`, `@jab/web`) — a hosted platform for agencies who want the headless frontend without writing or owning code. See [`docs/saas-mvp-transition.md`](./docs/saas-mvp-transition.md).

> Project name is a placeholder — see [`CLAUDE.md`](./CLAUDE.md) for context.

## Repository layout

```
wp-headless-kit/
├── packages/
│   ├── wp-plugin/             # PHP — the WordPress plugin (v0.4.0)
│   ├── core/                  # @jab/core — pure-function engine
│   ├── cli/                   # @jab/wp-headless-cli — local-first CLI
│   └── frontend-template/     # Next.js playground (not published)
├── apps/
│   └── web/                   # @jab/web — managed headless platform SaaS (Phase 2+, see docs/saas-mvp-transition.md)
├── pilots/
│   └── tworoads/              # Pilot output (gitignored)
├── docs/
│   ├── saas-mvp-transition.md # SaaS phase plan + content model + audit findings
│   ├── hosting.md             # Hosting decision (Vercel for MVP, Cloudflare scale target)
│   ├── saas-failure-states.md # User-facing failure copy catalog
│   └── concierge-runbook.md   # Operator playbook for the Phase 0 concierge motion
└── CLAUDE.md
```

## Where to start

Read [`CLAUDE.md`](./CLAUDE.md) — it has the architecture, current plugin release notes, conventions, and anti-patterns. Every contributor (human or AI) should load that file first.

For the SaaS track:

- [`docs/saas-mvp-transition.md`](./docs/saas-mvp-transition.md) — phase plan + content model (WP-managed vs Jab-managed) + open decisions. Read before any `apps/web` work.
- [`docs/jab-brand.md`](./docs/jab-brand.md) — JAB dark brand system: palette, typography, tokens, conventions, the Site Detail "real data + mocked extras" pattern, anti-patterns. Read before any visual work in `apps/web`.
- [`docs/hosting.md`](./docs/hosting.md) — Vercel-for-MVP decision and the provider-seam requirement for the eventual Cloudflare migration.
- [`docs/saas-failure-states.md`](./docs/saas-failure-states.md) — user-facing copy for every failure path the engineering audit surfaced.
- [`docs/concierge-runbook.md`](./docs/concierge-runbook.md) — the Phase 0 motion an operator uses while the hosting layer is being built.

For package-specific docs:

- [`packages/wp-plugin/README.md`](./packages/wp-plugin/README.md) — installable WP plugin (abilities, ACF mapping, audit closure).
- [`packages/cli/README.md`](./packages/cli/README.md) — `jab scaffold` / `init` / `generate` / `sync`.
- [`packages/frontend-template/README.md`](./packages/frontend-template/README.md) — the Next.js starter the CLI emits.
