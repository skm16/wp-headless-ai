# SaaS apps/web — Conversion Pipeline (Current State)

> **What this is:** A "what's actually in the code today" walkthrough of the WordPress-to-headless conversion pipeline in `apps/web`. Snapshot date: 2026-05-27. Covers the SaaS managed-platform path; the `packages/` CLI kit is a separate product track and is not described here.
>
> **What this is not:** the architecture spec. The canonical design lives in [`saas-v2-component-pipeline.md`](saas-v2-component-pipeline.md) (the v2 architecture, decided 2026-05-25) and is sequenced in [`superpowers/plans/2026-05-25-saas-v2-roadmap.md`](superpowers/plans/2026-05-25-saas-v2-roadmap.md). This doc reads the code and reports what works.
>
> **TL;DR:** Phases A–D are built and have working smoke tests. Phases E–F (Verify, Review/Publish) are spec'd but not in code. A full end-to-end build through Vercel deploy is possible today; fidelity scoring and the review gate are the remaining gaps.

---

## 1. The narrative — how a site converts (and where it stops)

A small/medium agency wants to give their client a fast, modern Next.js frontend without taking on a React engineering team. The promise: keep WordPress as the CMS the client already knows; let JAB do the build and the iteration.

The shape the agency walks through today:

1. **Sign up + create a project.** Standard email/password auth (Supabase) creates a tenant and a project row.
2. **Onboarding wizard.** Four steps in [`app/(app)/projects/[id]/onboard/page.tsx`](../apps/web/app/(app)/projects/[id]/onboard/page.tsx):
   - **Intent** — pick one of three fidelity intents (faithful / refresh / reimagine). Stored on `projects.intent`. Only "faithful" is honored by Phase B today; the other two are UI-only.
   - **Probe** — paste a WordPress URL, username, and Application Password. The server-side action calls the JAB plugin's MCP manifest endpoint, decrypts and stores the credentials, persists the manifest JSONB on the project row, and fires `project/design.requested` so a background worker can pull the homepage's design tokens (logo, palette, typography, brand personality). Onboarding does **not** block on that worker.
   - **Ownership** — pick per-content-type management (WP-managed vs Jab-managed). Stored on `projects.content_ownership` as JSONB.
   - **Confirm** — sets `projects.onboarded_at` and flips `projects.status` to `ready`.
3. **Build a site.** This is where the pipeline kicks in. Today the build is triggered manually via the smoke harness (`scripts/smoke-discover-site.ts`) — there is no UI "Build" button yet. The smoke harness inserts a `site_builds` row and fires `site/discover.requested`.
4. **Phase A — Discovery** runs (~30s–2min). The `discoverSite` worker enumerates the WP site's menus, post types, and per-page block trees via the JAB plugin's typed MCP abilities, runs Playwright to capture screenshots + computed CSS per page, and writes `block_inventory` + `page_inventory` rows. Inventory is tiered: visual / standard / trivial / passthrough.
5. **(Manual hop)** Today the operator runs `scripts/smoke-generate-components.ts` against the same `buildId` to dispatch `site/components.requested`. The intended auto-chain from Phase A → Phase B is **deferred to the Stage 7 orchestrator**, which is not yet built.
6. **Phase B — Component Generation** runs (~3–5min). The `generateComponents` worker reads `block_inventory`, batches non-passthrough blocks 5 at a time, and routes each block to a tier-appropriate prompt + model. Generated `.tsx` files land in Supabase Storage under `builds/<buildId>/components/<BlockName>.tsx`. Per-block model + token usage is written back to `block_inventory`. On exit the worker flips `site_builds.status` to `composing` and dispatches `site/compose.requested`.
7. **Phase C — Compose & Shell** runs. The `composeSite` worker reads all generated component `.tsx` files from Storage, emits the full Next.js project tree (dispatcher, page templates, CPT routes, shell header/footer, Tailwind config, `lib/sdk/types.ts`), and optionally runs a full `tsc --noEmit` compile gate before advancing (on by default; set `JAB_COMPOSE_TYPECHECK=0` to skip). On success it flips `site_builds.status` to `building` and dispatches `site/build.requested`.
8. **Phase D — Build & Deploy** runs. The `deploySite` worker ensures a Vercel project exists, syncs env vars, downloads the composed project tree from Storage, deploys to Vercel via the REST API, polls until the deployment is ready, and writes the preview URL to `deployments`. On failure it captures the full build log to `builds/<buildId>/build-log.txt` in Storage and updates `site_builds.status` to `failed`.
9. **(End of the wired chain.)** There is no fidelity-verification worker, no review UI, and no publish action yet. The build sits at `status='deployed'` (or `failed`).

That is the current state. Phases A–D are real and wired end-to-end — credentials, manifests, screenshots, block trees, typed components, composed project, Vercel deploy, and build log capture all work. Phases E–F (fidelity verification and the review/publish gate) exist as design docs and are not yet in code.

---

## 2. Where each phase lives in the repo

| Phase | Status | Worker / entry point | Trigger event | Output state |
|---|---|---|---|---|
| **Pre-A** — Design tokens | ✅ Built | [`lib/inngest/functions/extract-project-design.ts`](../apps/web/lib/inngest/functions/extract-project-design.ts) | `project/design.requested` | `projects.design_tokens`, `projects.personality`, asset paths |
| **A** — Discovery | ✅ Built | [`lib/inngest/functions/discover-site.ts`](../apps/web/lib/inngest/functions/discover-site.ts) | `site/discover.requested` | `block_inventory`, `page_inventory`, screenshots in Storage |
| **B** — Components | ✅ Built | [`lib/inngest/functions/generate-components.ts`](../apps/web/lib/inngest/functions/generate-components.ts) | `site/components.requested` | `.tsx` files in Storage, `block_inventory` cost telemetry |
| **C** — Compose & Shell | ✅ Built | [`lib/inngest/functions/compose-site.ts`](../apps/web/lib/inngest/functions/compose-site.ts) | `site/compose.requested` | assembled Next.js file tree in Storage; ships with compile gate (on by default — runs `tsc --noEmit` before deploy dispatch; set `JAB_COMPOSE_TYPECHECK=0` to skip) |
| **D** — Build & Deploy | ✅ Built | [`lib/inngest/functions/deploy-site.ts`](../apps/web/lib/inngest/functions/deploy-site.ts) | `site/build.requested` | `deployments` row, Vercel preview URL, build log in Storage on failure |
| **E** — Verify | ❌ Not built | (would be `verify-fidelity.ts`) | `site/verify.requested` | (would write `fidelity_reports` rows) |
| **F** — Review + publish | ❌ Not built | (would be `app/(app)/projects/[id]/builds/[buildId]/review`) | User action | (would promote `deployments` preview → production) |
| **Orchestrator** | ❌ Not built | (would be `build-site.ts`) | `site/build.requested` | Chains A → B → C → D → E with progressive disclosure UX |

The Inngest entry point that registers handlers is [`app/api/inngest/route.ts`](../apps/web/app/api/inngest/route.ts) — five functions are registered: `extractProjectDesign`, `discoverSite`, `generateComponents`, `composeSite`, `deploySite`.

---

## 3. The connected-site contract — how `apps/web` talks to WordPress

The conversion pipeline is built on the JAB WordPress plugin v0.6.0+, which exposes typed MCP abilities over a thin REST shim. The contract:

- **Plugin floor:** v0.6.0. The plugin exposes the typed `BlockNode[]` schema (one variant per registered block type, ACF blocks enriched) and a `/wp-json/jab/v1/manifest` endpoint the SaaS uses to discover ability names + wrapper keys per CPT. The current release line is v0.6.3 (per [`CLAUDE.md`](../CLAUDE.md) and the plugin's own README).
- **Auth:** WordPress Application Passwords. Encrypted on the project row (`projects.wp_app_password_encrypted` as `bytea`).
- **Transport:** MCP over HTTP, brokered by `@jab/core`'s `McpClient`. The SaaS does not own the protocol — see the bridge in [`lib/jab/ability-client.ts`](../apps/web/lib/jab/ability-client.ts).
- **Block representation:** `BlockNode { blockName: string | null, attrs: Record<string, unknown>, innerBlocks: BlockNode[], innerHTML: string, innerContent: (string | null)[] }`. This is the *prop type* for the components Phase B generates — no translation layer needed.

The ability surface the SaaS calls is exported from [`lib/jab/ability-client.ts`](../apps/web/lib/jab/ability-client.ts): `createJabMcpClient`, `loadJabCredentials`, `getMenus`, `listPostTypes`, `listPostType`, `getPostBySlug`, `getGlobalStyles`, `resolveCptAbilityMeta`.

---

## 4. Pre-Phase A — Onboarding + design tokens

### What the onboarding wizard does

[`app/(app)/projects/[id]/onboard/onboarding-wizard-client.tsx`](../apps/web/app/(app)/projects/[id]/onboard/onboarding-wizard-client.tsx) drives the four-step flow. Each step calls a server action in [`lib/actions/onboarding.ts`](../apps/web/lib/actions/onboarding.ts):

1. **`saveIntentAction`** — writes `projects.intent`.
2. **`connectWpAction`** — fetches the WP manifest via the MCP handshake, encrypts and writes `wp_url`, `wp_username`, `wp_app_password_encrypted`, persists the `manifest` JSONB, and fires `project/design.requested`. Failure modes propagate as typed errors with explicit messages.
3. **`saveOwnershipAction`** — writes `projects.content_ownership` (per-content-type WP vs Jab assignment).
4. **`completeOnboardingAction`** — sets `projects.onboarded_at` and flips `projects.status` to `ready`.

### What `extractProjectDesign` does (Pre-Phase A worker)

Triggered by `project/design.requested` from `connectWpAction`. Two steps:

1. **`scrape`** — one Sonnet 4.6 call against the WP homepage HTML to extract color palette, typography pairs, button styles, and brand personality (tone / energy / audience). The deterministic-signals layer in [`lib/ai/scrape-design-deterministic.ts`](../apps/web/lib/ai/scrape-design-deterministic.ts) pre-extracts colors and font names via Cheerio so the LLM is translating rather than guessing.
2. **`capture-assets`** — downloads logo / favicon / OG image into the `project-assets` Storage bucket at `projects/<projectId>/<kind>.<ext>`.
3. **`persist`** — writes the `design_tokens` (color palette, font sizes, font families, etc.), `personality`, and asset paths to the project row.

`retries: 0`. If it fails, the project's `design_tokens` is left null and downstream phases degrade to Tailwind defaults. The `discoverSite` worker re-dispatches `project/design.requested` opportunistically if it finds `design_tokens` null at the end of Phase A.

---

## 5. Phase A — Discovery (built)

**Entry:** `discoverSite` Inngest function ([`lib/inngest/functions/discover-site.ts`](../apps/web/lib/inngest/functions/discover-site.ts)). Triggered by `site/discover.requested` with `{ projectId, tenantId, buildId, maxPages? }`.

### Step-by-step

Each `step.run` boundary is independently traced + retry-able (function-level `retries: 0` means no retries actually fire, but step boundaries still bound the trace).

1. **`mark-discovering`** — flips `site_builds.status` to `discovering`, sets `started_at`.
2. **`load-creds`** — service-role read + decrypt of `wp_url`, `wp_username`, `wp_app_password_encrypted`.
3. **`probe-bucket`** — idempotent `site-screenshots` bucket bootstrap via [`lib/storage/bucket.ts`](../apps/web/lib/storage/bucket.ts).
4. **`load-manifest`** — reads `projects.manifest` (cached at onboarding time).
5. **`get-menus`** — `jab/get-menus` via MCP.
6. **`list-post-types`** — `/wp-json/wp/v2/types` directly (REST, not MCP), filtered to public types.
7. **`list-<cpt>`** (per post type) — `jab/get-<cpt>` list call. Hard-capped at `numberposts=100` per CPT (the plugin's input-schema maximum). Sites with > 100 entries per CPT lose the tail.
8. **`selectSeedPages`** ([`lib/jab/seed-pages.ts`](../apps/web/lib/jab/seed-pages.ts)) — keeps every page, one representative sample per non-page CPT. Rationale: Phase A is a template + block-type inventory job, not a content-harvesting job. Pulling all 88 beers from a brewery site adds zero new block-type signal.
9. **`blocks-<cpt>-<slug>`** (per page) — `jab/get-<cpt>-by-slug` with `includeBlocks=true`, returning typed `BlockNode[]`. Sequential per-page calls; the `maxPages` smoke cap bounds this when testing.
10. **`capture-screenshots`** — Playwright pass via [`lib/jab/playwright-discovery.ts`](../apps/web/lib/jab/playwright-discovery.ts), brokered by an `InProcessRunner` ([`lib/jab/discovery-runner.ts`](../apps/web/lib/jab/discovery-runner.ts)). Captures full-page screenshots + per-element computed CSS. Best-effort: capture failures are recorded in `failures` and the rest of the pipeline proceeds (see design doc §6.2.1 — Cloudflare bot protection made auto-capture unreliable for Two Roads).
11. **`build-inventory`** ([`lib/jab/inventory.ts`](../apps/web/lib/jab/inventory.ts)) — pure reducer: walks every `BlockNode[]` tree, accumulates `attr_samples` (capped at ~5 distinct shapes per block name), `occurrence_count`, `page_slugs`, and assigns a tier per the §6.4 heuristics seed.
12. **`enrich-inventory`** ([`lib/jab/content-detection.ts`](../apps/web/lib/jab/content-detection.ts)) — heuristic detection of ACF Flexible Content layouts (`acf_flex`) and CPT template wrappers (`cpt_template`). Discriminates `kind` and sets `spec` JSONB with per-kind context (ACF sub_fields, block-type union for CPT templates).
13. **`aggregate-computed-styles`** ([`lib/jab/aggregate-computed-styles.ts`](../apps/web/lib/jab/aggregate-computed-styles.ts)) — collapses per-element computed CSS into per-block-name aggregates (median, range, viewport variants).
14. **`fetch-global-styles`** — `/wp-json/wp/v2/global-styles` for theme.json design tokens. Merged into `projects.design_tokens.themeJson`. Fail-soft: classic themes without theme.json gracefully skip.
15. **`persist-inventory`** + **`persist-pages`** — bulk inserts into `block_inventory` + `page_inventory`. Storage paths reference the Playwright screenshots from step 10.
16. **`finalize-counts`** — writes `page_count` + `block_type_count` back to `site_builds`. **Status stays at `discovering`** — Stage 7's orchestrator is supposed to flip to `components` when Phase B starts; v1 standalone smoke leaves it at `discovering` for clarity that Phase B hasn't auto-chained.
17. **`warn-design-tokens`** — fail-soft re-dispatch of `project/design.requested` if `design_tokens` is still null.

### What gets persisted

| Table | Per-row meaning | Written by | Read by |
|---|---|---|---|
| `block_inventory` | One row per unique block name in this build. Columns: `block_name`, `kind` (block / acf_flex / cpt_template), `tier`, `attr_samples` JSONB, `computed_styles` JSONB, `page_slugs[]`, `occurrence_count`, `spec` JSONB (per-kind context). Cost-telemetry columns (`model_used`, `*_tokens`, `compile_status`) start null. | Phase A | Phase B |
| `page_inventory` | One row per page to render. Columns: `slug`, `post_type`, `title`, `route_path`, `block_count`, `source_screenshot_paths` JSONB, `rendering` (static / dynamic). | Phase A | Phases C–E |
| `site_builds` | One row per build attempt. Status transitions: `queued → discovering → components → composing → building → verifying → ready` (or `failed` / `cancelled`). | All phases | All phases + UI |

### Smoke test

[`scripts/smoke-discover-site.ts`](../apps/web/scripts/smoke-discover-site.ts). Run as:

```
pnpm tsx scripts/smoke-discover-site.ts <projectId> <tenantId> [maxPages]
```

Dispatches the event to the Inngest dev server, polls `site_builds` for completion, asserts that `page_inventory` + `block_inventory` populated and screenshots landed in Storage. Default timeout 8 minutes. The Two Roads pilot is the canonical target site.

---

## 6. Phase B — Component Generation (built)

**Entry:** `generateComponents` Inngest function ([`lib/inngest/functions/generate-components.ts`](../apps/web/lib/inngest/functions/generate-components.ts)). Triggered by `site/components.requested` with `{ projectId, tenantId, buildId }`.

### What it does

1. **`mark-components-phase`** — flips `site_builds.status` to `components`.
2. **`load-inventory`** — reads every `block_inventory` row for the build (passthrough rows included — see below).
3. **`load-tokens`** — reads `projects.design_tokens` for Tailwind context.
4. **Queue ordering** — homepage-first (blocks whose `page_slugs` overlap `{"home", "homepage", "/"}` go first), then descending by `occurrence_count`. The intent (per design doc §5) is that homepage components finish first so Phase C₁ (homepage compose) can start before the full queue completes.
5. **`generate-batch-N`** — non-overlapping batches of 5 blocks each. Within a batch, `Promise.all` parallelizes the per-block `generateComponent` + `persistGeneration` calls. The Inngest retry unit is the batch, not the individual component (idempotent: compile failure → passthrough; Storage upsert overwrites).
6. **`update-counts`** — writes `component_count`, **flips `site_builds.status` to `composing`**, sets `finished_at`.
7. **`dispatch-compose`** — sends `site/compose.requested` to Inngest. **No worker handles this event.** (See §10 — gap.)

### Per-block generation — `generateComponent`

Lives in [`lib/ai/component-generator.ts`](../apps/web/lib/ai/component-generator.ts). For each block:

- **Passthrough short-circuit** — if `tier === 'passthrough'` or `blockName === null`, emit the `passthroughFallback` TSX (a thin wrapper around `RichTextContent`, which sanitizes `innerHTML` via DOMPurify) and return with `compileStatus='skipped'`. No LLM call.
- **Tier → model + prompt** — driven by `modelClientForTier` in [`lib/ai/model-client.ts`](../apps/web/lib/ai/model-client.ts):

  | Tier | Model | Max tokens | Prompt builder |
  |---|---|---|---|
  | `visual` | `claude-sonnet-4-6` (vision) | 8192 | `visualPrompt` — design tokens + attr samples + screenshot crop |
  | `standard` | `claude-sonnet-4-6` (text) | 4096 | `standardPrompt` — design tokens + attr samples |
  | `trivial` | `claude-haiku-4-5-20251001` | 2048 | `trivialPrompt` — minimal, single attr sample |
  | `cpt_template` (kind) | follows tier | per-tier | `cptTemplatePrompt` — block-type union + breadcrumb/title slot |
  | `acf_flex` (kind) | follows tier | per-tier | `acfFlexPrompt` — sub_fields shape + optional screenshot |

- **Two-attempt loop** — on attempt 0, `cacheSystemPrompt: true` so the shared system prompt + design tokens get an Anthropic `cache_control: {type:"ephemeral"}` marker. On a failure (API error, output exceeds 10KB, or `validateTsx` returns syntax diagnostics), retry once with caching off. If both fail, emit the `passthroughFallback` and record `compileStatus='failed'`.
- **TSX validation** — `validateTsx` uses `ts.createSourceFile(..., ScriptKind.TSX)` and reads the (internal) `parseDiagnostics` array. This catches JSX syntax errors (malformed tags, unclosed elements) but **does not catch type or import errors** — those need a full program. Phase D's `next build` is intended to be the hard compiler gate.
- **Cost telemetry** — `model_used`, `provider_used`, `input_tokens_cached`, `input_tokens_uncached`, `output_tokens`, `compile_status`, `compile_attempt_count` are written back to the `block_inventory` row by `persistGeneration` ([`lib/ai/persist-generation.ts`](../apps/web/lib/ai/persist-generation.ts)).

### Mock mode

Set `JAB_GENERATE_MOCK=1` in the Inngest worker's environment. `MockModelClient` ([`lib/ai/model-client.ts:136`](../apps/web/lib/ai/model-client.ts#L136)) returns a fixed, valid TSX with a visible "MOCK" badge and zero token usage. Used by the Phase B smoke harness to verify orchestration end-to-end at zero API cost. A real-mode dry-run is also possible but not the default.

### Smoke test

[`scripts/smoke-generate-components.ts`](../apps/web/scripts/smoke-generate-components.ts). Run as:

```
pnpm tsx scripts/smoke-generate-components.ts <projectId> <tenantId> <buildId>
```

Dispatches the event, polls for `site_builds.status → composing`, asserts that `.tsx` files landed in Storage and `block_inventory.compile_status` populated. Default timeout 15 minutes.

---

## 7. Storage layout

Two Supabase Storage buckets:

| Bucket | Visibility | Path | Written by | Read by |
|---|---|---|---|---|
| `project-assets` | Public | `projects/<projectId>/{logo,favicon,og_image}.<ext>` | `captureAssets` (Pre-Phase A) | Phase B prompts, Phase C shell generators (future) |
| `site-screenshots` | Private (tenant-scoped) | `builds/<buildId>/source/<slug>_<viewport>.png` | Phase A | Phase B (visual tier), Phase E (future) |
| `site-screenshots` | Private | `builds/<buildId>/components/<BlockName>.tsx` | Phase B | Phase C (future) |
| `site-screenshots` | Private | `builds/<buildId>/generated/<slug>_<viewport>.png` | Phase E (future) | Phase F (future) |

Note that `.tsx` source files share the `site-screenshots` bucket — it's a private per-build artifact store, not literally screenshots-only. Bucket bootstrap is idempotent ([`lib/storage/bucket.ts`](../apps/web/lib/storage/bucket.ts)).

---

## 8. Database schema overview

The Drizzle TS source ([`lib/db/schema.ts`](../apps/web/lib/db/schema.ts)) mirrors the canonical SQL DDL in [`drizzle/migrations/*.sql`](../apps/web/drizzle/migrations/). Migration 0014 is the v2 schema teardown + creation (see §9).

### Tables in the pipeline

| Table | Phase | Notes |
|---|---|---|
| `profiles` | Auth | Mirror of Supabase `auth.users`. |
| `tenants` | Auth | Workspace/organization. |
| `tenant_members` | Auth | `(tenant_id, user_id)` PK; role text. |
| `projects` | Onboarding | The conversion target. Holds WP creds, manifest JSONB, design_tokens, personality, asset paths, content_ownership, intent. |
| `rate_limits` | Utility | Hourly fixed-window counters. Service-role only, RLS-locked. |
| `generation_jobs` | **v1 vestige** | Per-page-generation job records. Not actively referenced by Phase A/B; carried over from the deleted preview path. Audit recommended. |
| `site_builds` | A–E | One row per build attempt. Drives the cross-phase status machine. |
| `deployments` | D, F | Preview + production URL tracking. |
| `block_inventory` | A → B | Per-build unique-block-type catalog with cost telemetry. |
| `page_inventory` | A → C, E | Per-build page list + screenshot paths. |
| `fidelity_reports` | E → F | Per-page fidelity score + structured issue list. |

### RLS posture

Every v2 table is tenant-scoped through `project_id → projects.tenant_id`. The pattern is uniform: **SELECT-only policies for tenant members; INSERT/UPDATE/DELETE go through service-role workers.** This is intentional — a member must not be able to fabricate a `site_builds` row with `status='ready'` and bypass Phase F approval. The Phase F approval path will need a `SECURITY DEFINER` RPC to allow column-restricted writes to `fidelity_reports.approval_status` (per the comment at [migration 0014:367](../apps/web/drizzle/migrations/0014_saas_v2_schema.sql#L367)). That RPC is not yet built.

---

## 9. What changed in migration 0014 — the v2 teardown

The v1 preview path was removed in one transaction. Reading [`drizzle/migrations/0014_saas_v2_schema.sql`](../apps/web/drizzle/migrations/0014_saas_v2_schema.sql) end-to-end is the cleanest single-file overview of "what got cut" and "what got added."

**Dropped:**
- `anonymous_previews` table (pre-auth preview funnel).
- `promote_anonymous_preview()` function (the atomic claim-and-create).
- `projects.preview_html` column (the wow-HTML snapshot).
- `projects.preview_html_status` (the regen state machine).
- `projects.usage` (per-pass token telemetry).

**Added:**
- `site_builds`, `deployments`, `block_inventory`, `page_inventory`, `fidelity_reports`.
- SELECT-only RLS policies on all five.

**Migration 0015** (`0015_inventory_kind_spec.sql`) followed up by adding `block_inventory.kind` and `block_inventory.spec` for the ACF Flex / CPT template discrimination Phase B routes on.

---

## 10. Gaps and concerns

This section is the honest part. Items are ranked roughly by how likely they are to bite.

### G1 — Phase A → Phase B does not auto-chain

`discoverSite` finalizes counts and leaves `site_builds.status='discovering'`. It does not dispatch `site/components.requested`. The intended auto-chain lives in the Stage 7 orchestrator (`build-site.ts`), which does not exist. Today, the only way to advance a build past Phase A is to manually fire `site/components.requested` (the smoke harness does this).

**Why this matters:** there is no "Build site" button you can wire to a UI — the cross-phase event chain has to be designed before that surface can be built. See [`superpowers/plans/2026-05-25-saas-v2-roadmap.md`](superpowers/plans/2026-05-25-saas-v2-roadmap.md) Stage 7.

### G2 — `site/compose.requested` is now handled (Phase C shipped)

`generateComponents` flips `site_builds.status` to `composing` and dispatches `site/compose.requested`. The `composeSite` Inngest function handles this event. The full compose → deploy chain is wired. This gap is closed.

### G3 — Phases E and F are spec'd but not in code

Phases C and D have landed. The remaining unbuilt phases:

- **Phase E (Verify):** No Playwright pass against the deployed preview URL, no `pixelmatch` integration, no vision-LLM fidelity scoring, no `verify-fidelity.ts` worker. `fidelity_reports` is empty by construction.
- **Phase F (Review + Publish):** No review-screen route under `app/(app)/projects/[id]/builds/[buildId]/review/`. No `regenerate-component.ts` worker. No publish action. The Phase F UI components in `components/` (fidelity-report, intent-picker, iteration-panel, preview-compare, ownership-picker) exist as **demos in `app/ui-kit/`** and are not wired to real data.

### G4 — Trivial-tier model deviates from the design doc

Design doc [§6.4](saas-v2-component-pipeline.md#64-tiered-component-generation) prescribes Gemini 1.5 Flash for the trivial tier ("the single biggest model-switching win in the pipeline" — ~1/15th the cost of Sonnet). The code at [`lib/ai/model-client.ts:202`](../apps/web/lib/ai/model-client.ts#L202) uses `claude-haiku-4-5-20251001` instead. The choice is intentional (v1 stays Anthropic-only for one SDK / one set of API keys / one cache surface) but it means **the per-build cost estimate in the design doc is optimistic** for the trivial-heavy block tail. If a Two Roads-scale site has 15 trivial blocks, the difference is meaningful even at small absolute numbers.

### G5 — Anthropic Batch API is not used

Design doc [§6.7b](saas-v2-component-pipeline.md#67-cost-optimization-levers-apply-before-changing-providers) calls Batch API "~$0.20/build savings." Phase B uses in-process `Promise.all` of 5 concurrent calls instead — synchronous, 100% pricing. The decision is documented in the plan ("not Batch API — see plan decision #4") but the cost-budget estimate in the design doc assumed Batch.

### G6 — Per-CPT pagination cap

`discoverSite` calls `listPostType` with `numberposts: 100` — the plugin's input-schema maximum. **Sites with more than 100 entries in any single CPT will silently lose the tail.** The seed-page selection saves us from over-fetching (Phase A only pulls block-level samples), but the *listing* itself is capped. A breweries site with 250 beers will inventory only the first 100 from the list call.

Two Roads is under 100 across the board, so the pilot is unaffected. A larger site requires pagination support, which means either iterating `page` params or a plugin change to lift the cap.

### G7 — Capture reliability against Cloudflare-protected sites

Design doc [§6.2.1](saas-v2-component-pipeline.md#621-capture-reliability--best-effort--client-supplementation-decided-2026-05-26) acknowledges this: headless Chromium against Cloudflare-fronted WP sites lands ~10% capture success per page (validated against Two Roads). The current code path is best-effort — capture failures are recorded but the pipeline continues. The mitigation (client-uploaded screenshots during onboarding) is **not yet built**. Until it lands, visual-tier prompts for Cloudflare-protected sites will fall back to block-tree-only generation, which is a meaningful fidelity hit for themed/custom blocks.

### G8 — `projects.intent` deviates from the new pipeline

`intent` is captured at onboarding (faithful / refresh / reimagine) and persisted. The current Phase B prompts in [`lib/ai/component-generator.ts`](../apps/web/lib/ai/component-generator.ts) **do not branch on intent** — every prompt is implicitly "faithful." Refresh and Reimagine are UI-only today; the column will need to retire or wire through Phase B prompts in a future stage (Stage 0 decision #2 said retire in Stage 2; still present).

### G9 — `generation_jobs` is a v1 vestige

This table was the per-page LLM job record in the old preview-render flow. Phase A and Phase B do not write to it. It's not in any obvious removal path. **Recommend an audit** — if no live code references it, drop in a follow-up migration. If something still writes, document what.

### G10 — Homepage-slug detection in Phase B is hard-coded

[`generate-components.ts:135`](../apps/web/lib/inngest/functions/generate-components.ts#L135):

```ts
const homepageSlugs = new Set(["home", "homepage", "/"]);
```

This is the front-page detection that drives queue ordering. The WP front-page slug is actually resolved via the REST `show_on_front` setting (see [`ability-client.ts:13`](../apps/web/lib/jab/ability-client.ts#L13) "Resurrects `safeFindFrontPage`" — but `ability-client.ts` does not currently export `safeFindFrontPage`; the resurrect was deferred). For a WP install whose front page is `/landing` or `/welcome`, homepage-first ordering silently fails. Phase A's `routePathFor` already documents this as a Stage 3 concern, but it leaks into Phase B today.

### G11 — TSX validation has limited scope

`validateTsx` reads `ts.SourceFile.parseDiagnostics`, which is **a TypeScript internal field** that could be renamed or removed in a future major. The code logs a warning if the field is missing but then returns "no errors" — silently accepting malformed TSX as valid (see [`component-generator.ts:189`](../apps/web/lib/ai/component-generator.ts#L189)). Phase D's `next build` is the intended hard gate, but Phase D doesn't exist yet. Until then, the only compile signal is syntax-level.

### G12 — The Phase F approval write path is unspecified

RLS policies on `fidelity_reports` deliberately omit UPDATE because a member-scoped policy can't restrict column-level tampering. The plan calls for a `SECURITY DEFINER` RPC that accepts only the approval columns ([`migration 0014:367`](../apps/web/drizzle/migrations/0014_saas_v2_schema.sql#L367)). That RPC's shape, parameter validation, and audit-log story are unwritten. Anyone building Phase F has to design this before the approve button can be wired.

### G13 — Cross-phase failure recovery is minimal

`retries: 0` is the convention across every worker. Failure recovery is "re-trigger the event manually." There is no fan-in compensation logic (Phase B partial completion leaves a half-populated `block_inventory`; re-triggering re-batches everything because `persistGeneration` upserts, but partial Storage state is not cleaned up). Stage 7 orchestration will need to define what "resume a failed build" means — today, the only safe resume is "kick off a new build_id."

### G14 — Demo components in `app/ui-kit/` aren't wired to real data

`components/intent-picker.tsx`, `iteration-panel.tsx`, `preview-compare.tsx`, `fidelity-report.tsx`, `ownership-picker.tsx` exist and render against mock data in `app/ui-kit/*-demo.tsx`. The onboarding wizard uses some of them (intent-picker, ownership-picker) wired to server actions. **None of the build-review components are wired** — `fidelity-report` cannot accept a `fidelity_reports` row because no row will ever exist until Phase E is built.

This isn't a bug, but it's a foot-gun for someone new to the repo: the UI library suggests a much more complete product than the backend supports.

---

## 11. End-to-end checklist — what works today, what doesn't

Against a fresh WP install (Two Roads Brewing, with the JAB plugin v0.6.3+):

- [x] Agency can sign up + create a project
- [x] Agency can complete the onboarding wizard (intent → probe → ownership → confirm)
- [x] WP credentials persist encrypted on the project row
- [x] Manifest JSONB caches on the project row
- [x] Background design-token scrape runs and populates `projects.design_tokens`, `personality`, and asset paths
- [x] Operator can manually create a `site_builds` row and fire `site/discover.requested`
- [x] Phase A completes — `block_inventory` + `page_inventory` populated, screenshots in Storage (best-effort on Cloudflare-protected sites)
- [x] Operator can manually fire `site/components.requested`
- [x] Phase B completes — `.tsx` files in Storage, `block_inventory` cost telemetry populated
- [x] Phase B → Phase C auto-handoff (event fired, `composeSite` handles it)
- [x] Phase C — compose the Next.js project file tree (with optional `tsc --noEmit` compile gate)
- [x] Phase D — `next build` + Vercel deploy
- [x] `deployments` row written
- [x] Preview URL surfaced (on successful deploy)
- [ ] Phase E — fidelity scoring
- [ ] `fidelity_reports` row ever written
- [ ] Phase F — review UI
- [ ] Publish action (preview → production promotion)
- [ ] Custom domain / subdomain wiring
- [ ] Live agency-presentable site at a real URL

The product promise from the design doc ([§12](saas-v2-component-pipeline.md#12-what-success-looks-like)) — "8–13 minutes wall-clock, homepage milestone at ~4–5 min, full site at ~10 min, fidelity report, publish to `client.jab.app`" — is **not yet achievable end-to-end**. The first two phases of the build are wired; everything user-visible past the build trigger is missing.

---

## 12. Where to look next

- **Roadmap of unfinished stages:** [`docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md`](superpowers/plans/2026-05-25-saas-v2-roadmap.md). Stages 5 (Phase E), 6 (Phase F), and 7 (orchestration + UX polish) remain as unwritten sub-plans. Stages 3 (Phase C) and 4 (Phase D) are shipped.
- **Stage 2 sub-plan that produced Phase B:** [`docs/superpowers/plans/2026-05-26-saas-v2-stage-2-component-pipeline.md`](superpowers/plans/2026-05-26-saas-v2-stage-2-component-pipeline.md). Reading it shows the granularity expected for the remaining stages.
- **Failure-mode catalog:** [`docs/saas-failure-states.md`](saas-failure-states.md) — the user-visible error states the SaaS needs to surface. Many reference flows the pipeline can't reach yet.
- **Brand + UI surfaces:** [`docs/jab-brand.md`](jab-brand.md) — the dark brand the SaaS chrome already ships. Future Phase F surfaces must follow it.
- **Plugin contract:** [`packages/wp-plugin/README.md`](../packages/wp-plugin/README.md) — block-schema correctness, ACF schema cache invalidation, and the manifest endpoint the SaaS depends on. Current release v0.6.3.

---

## 13. One-line summary for a colleague

> Phases A–D (discover, generate, compose, deploy) are real and have working smoke tests. The build chain runs end-to-end through a Vercel preview URL. Phases E–F (fidelity verification and the review/publish gate) are designed but not yet built — a site cannot be published to a permanent URL today.
