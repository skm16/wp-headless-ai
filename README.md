# wp-headless-kit

A WordPress-to-Claude-Code headless toolkit. Convert traditional WordPress sites into AI-iterable headless frontends using WordPress core's official Abilities API and the `wordpress/mcp-adapter`, paired with an opinionated CLI generator and a Claude Code-native developer experience.

> Project name is a placeholder — see `CLAUDE.md` for context.

## Repository layout

```
wp-headless-kit/
├── packages/
│   ├── wp-plugin/             # PHP — the WordPress plugin
│   ├── cli/                   # TypeScript — the CLI generator (not yet built)
│   └── frontend-template/     # Next.js — emitted starter project (not yet built)
├── pilots/
│   └── tworoads/              # Pilot output (gitignored)
├── docs/
└── CLAUDE.md
```

## Where to start

Read [`CLAUDE.md`](./CLAUDE.md) — it has the architecture, sprint plan, conventions, and anti-patterns. Every contributor (human or AI) should load that file first.
