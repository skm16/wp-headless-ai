# @jab/validate-ai

Throwaway script to **validate AI page-generation quality** before building the Phase D SaaS worker.

## Why this exists

Phase D wants to drop a Claude Agent SDK loop inside an Inngest function and have it generate a Next.js page from a WordPress site. Building the queue + retry + GitHub-push plumbing around an AI that can't produce decent output is the most expensive way to learn it can't.

This script isolates the **does Claude write good Next.js for our SDK?** question. It's the same code path Phase D will use (manifest fetch via `@jab/core`, typed SDK emission, page-DOM context) but minus all the production wiring. Iterate prompts here cheaply.

## Setup

```bash
cd scripts/validate-ai
cp .env.example .env
# Fill in WP creds + ANTHROPIC_API_KEY
pnpm install
```

## Run

```bash
pnpm --filter @jab/validate-ai generate
```

Each run produces a timestamped folder in `output/`:

```
output/
└── 2026-05-08T19-30-12-sharp-again-local/
    ├── page.tsx              # what Claude produced
    ├── meta.json             # token usage + timing + stop reason
    ├── system-prompt.md      # exact system prompt used
    └── user-prompt.md        # exact user prompt used
```

## Iteration loop

1. Run on `sharp-again.local` with the homepage path.
2. Open the produced `page.tsx`. Mentally diff against the live page.
3. Open the source page in a browser and compare visual hierarchy.
4. Edit `src/prompts.ts` — system or user prompt, your call.
5. Re-run. Compare across `output/` folders.
6. Once it's good on `sharp-again.local`, run on a second WP site (Two Roads, NMDA, anywhere with the Jab plugin installed). Confirm the prompt holds up.
7. Document which prompt won in a commit message; that's what Phase D inherits.

## What "good enough" means

- TS-strict-clean code (no `any`, no `@ts-ignore`)
- Server Component (no `"use client"`)
- Imports from `@/lib/sdk` for content fetching (no raw `fetch()`)
- Tailwind classes, semantic HTML
- Visual structure approximates the source — hero / sections / CTA / footer present where the source has them
- Token cost per run baselined (logged in `meta.json`)

If 3-5 sites all produce acceptable output, **proceed to Phase D**. If output is structurally broken (hallucinated abilities, missing entire sections, can't infer layout), **stop and rethink** — likely needs Playwright screenshot + multimodal input, or a different design-extraction strategy entirely.

## What this does NOT do

- **No iteration loop inside the agent.** Production Phase D will use the Agent SDK so the worker can read the page itself, fetch additional pages, validate output. Here we just want one shot to see baseline quality.
- **No GitHub push.** Output is a local file; you eyeball it.
- **No Playwright screenshot.** DOM-only first. If quality is bad with DOM alone, that's the signal to add screenshots, not the default.
- **No tests.** Throwaway script. Code from this folder doesn't ship.

## After Phase D ships

Delete this folder. The prompt-engineering work moves into `apps/web/lib/ai/prompts/`. This was scaffolding.
