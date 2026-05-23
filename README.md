# wp-headless-kit

A WordPress-to-Claude-Code headless toolkit. Convert traditional WordPress sites into AI-iterable headless frontends using WordPress core's official Abilities API and the `wordpress/mcp-adapter`, paired with an opinionated CLI generator and a Claude Code-native developer experience.

> Project name is a placeholder — see [`CLAUDE.md`](./CLAUDE.md) for context.

## Repository layout

```
wp-headless-kit/
├── packages/
│   ├── wp-plugin/             # PHP — the WordPress plugin (v0.3.0)
│   ├── core/                  # @jab/core — pure-function engine (extracted Phase A)
│   ├── cli/                   # @jab/wp-headless-cli — local-first CLI
│   └── frontend-template/     # Next.js playground (not published)
├── apps/
│   └── web/                   # @jab/web — multi-tenant SaaS shell (Phase B+)
├── pilots/
│   └── tworoads/              # Pilot output (gitignored)
├── docs/
│   └── superpowers/
│       ├── plans/             # Per-feature implementation plans
│       └── specs/             # Approved design specs
└── CLAUDE.md
```

## Where to start

Read [`CLAUDE.md`](./CLAUDE.md) — it has the architecture, current plugin release notes, conventions, and anti-patterns. Every contributor (human or AI) should load that file first.

For package-specific docs:

- [`packages/wp-plugin/README.md`](./packages/wp-plugin/README.md) — installable WP plugin (abilities, ACF mapping, schema-correctness fixes).
- [`packages/cli/README.md`](./packages/cli/README.md) — `jab scaffold` / `init` / `generate` / `sync`.
- [`packages/frontend-template/README.md`](./packages/frontend-template/README.md) — the Next.js starter the CLI emits.
