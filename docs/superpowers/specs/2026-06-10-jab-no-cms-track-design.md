# JAB No-CMS Track — Vision & Decomposition

> **Status:** Draft for review (2026-06-10, Sean). Strategy/vision artifact — **not** a single-implementation contract. Per-piece implementation specs (§8) follow when a piece is greenlit.
> **Scope:** `apps/web` (`@jab/web`). Adds a content-source-agnostic product track alongside the existing WordPress migration track. Does **not** touch `packages/wp-plugin`.
> **Premise (decided in brainstorm 2026-06-10):** keep JAB's workflow — dashboard → AI builds/edits → deploy → review → promote — but make WordPress **one of several** content sources rather than a hard precondition. Clients manage CMS-less sites (and, optionally, host their custom apps) from the same dashboard.
> **Ground-truth snapshot:** 2026-06-10, branch `feat/saas-e2e-loop`, latest migration **0033** (`page_inventory.link`).

---

## 1. Overview

The platform today takes a **connected WordPress site** end to end: `discover → components → compose → deploy(preview) → verify → review → promote`. WordPress is a hard precondition — onboarding requires a WP URL + Application Password, discovery crawls WP via the MCP abilities, and the *deployed* site calls back to WordPress at request time.

This design opens a second track: **no CMS.** The same dashboard, build pipeline, review gate, promote path, and chat-edit loop are reused, but the *source of truth* is no longer a live WordPress install. Two things change at the ends of the pipeline; everything in the middle is shared.

The track is grounded against a real client (`C:\Projects\mfit`, §7): an operational PWA whose only use of WordPress is as a read-only marketing CMS. JAB replaces that WordPress — not the app.

### What this is, and what it is not

- **Is:** a drop-in replacement for "headless-WordPress-as-marketing-CMS." A way to generate, chat-manage, and host fast static marketing sites with no CMS behind them — from a brief, from an existing site, or (still) from WordPress.
- **Is not:** a tool for managing application logic. Auth, databases, realtime, cron, and business rules are out of scope. JAB manages *content surfaces*, not apps (it may *host* an app build — §3.5 — but it does not chat-manage one).

---

## 2. Grounding — how WP-coupled the pipeline actually is

A 6-agent codebase map (2026-06-10) classified every subsystem. The result: WordPress coupling lives at **two poles**, and the workflow we want to keep is the source-agnostic middle.

```
   INGEST POLE                    SHARED MIDDLE                         RUNTIME POLE
   (WP-specific)                  (source-agnostic)                     (WP-specific)

   discover-site  ─────►  components ─► compose ─► deploy ─► verify ─►   emitted site calls
   onboarding/connectWp     review ─► promote ─► chat-edit loop          callAbility() at
   (crawl live WP)          (LLM gen, Vercel, fidelity, the             request time (live
                            block-tree diff, polling, audit)            WP fetch per page)
```

| Subsystem | WP-coupling | Verdict |
|---|---|---|
| **Ingest** — `discover-site` + onboarding front door (`connectWp`, manifest probe, plugin-version gate, content-ownership) | Assumes a live WP URL + App Password to crawl | **Replace** |
| **Emitted runtime** — the deployed site's request-time fetches (`dynamic-lists-runtime`, `related-posts-runtime`, `createWpMediaResolver`, `McpClient`) | Live `callAbility` per page/list/related item | **Replace (delete for static)** |
| Component generation (Phase B) — `generate-components.ts`, `generateComponent()` | LLM prompt → TSX; pure | **Reuse** |
| Compose (Phase C) — `compose-site.ts` | Source-agnostic core, threaded with `wp_url` host-stripping, manifest routing, paradigm detection | **Adapt** |
| Deploy / host / promote (D, F) — `VercelClient`, `deploy-site.ts`, `publish-gate.ts`, `build-review.ts` | 80%+ generic; only `SYNCED_ENV_KEYS` triad, `baseUrl` fallback, `next.config` image-host harvest assume WP | **Adapt** |
| Verify / fidelity (E) — `verify-fidelity.ts`, `fidelity-score.ts` | Pure screenshot comparison | **Reuse (rubric shift)** |
| Chat-edit loop — `workspace-chat.ts`, `edit-site.ts`, `site-map.ts`, `edit-impact.ts` | The *loop* is reusable; the seams are `computeChangedPages` diffing WP block trees + `buildSiteMap` reading WP-sourced inventory | **Adapt** |
| Data model — `lib/db/schema.ts` | ~75% generic (tenants, projects, `site_builds`, `deployments`, `fidelity_reports`, `workspace_edits`, `conversations`, `chat_messages`); ~25% is WP discovery artifacts | **~75% reuse** |

**Key structural fact:** the runtime fetch is built on a dependency-injected `CallAbility` interface, and the pipeline speaks a `BlockNode[]` tree + a `Manifest` — both are *data-shape contracts*, not WP types. WordPress is the **first implementation** of "produce a block tree + manifest + a runtime data callable." The no-CMS track is a second implementation of the same contracts.

---

## 3. Core decisions

### 3.1 Shape A — chat-only static

Content is **baked into the generated code at build time.** Clients manage purely by chatting ("change the headline," "add a testimonials section") → AI regenerates → redeploys. There is no separate content editor and **no CMS-backed runtime data source** (the rare live widget is a contained, opt-in exception — see data islands, §4.4).

Consequence: the deployed artifact becomes a *genuinely* static Next.js site. This **deletes the entire runtime WP pole** — no `callAbility`, no `dynamic-lists-runtime`, no `related-posts-runtime`, no `createWpMediaResolver`, no `McpClient` session recovery, no ISR-from-WP, no origin-link rewriting. The no-CMS deployed site is *less* runtime machinery than the WP path, not more, and the WP track's hardest residuals (host aliases, fallback routing, runtime 404s) evaporate.

Rejected alternatives: "JAB becomes the CMS" (ship a structured content store + runtime data layer — bigger build, reopens the runtime pole) and "bring-your-own-headless" (connect Sanity/Contentful — contradicts the no-CMS premise).

### 3.2 The Block-tree IR — JAB authors its own `BlockNode` tree

The pipeline is already `BlockNode[] tree (data) → [LLM generates one component per block type] → [deterministic compose walks the tree] → TSX`. WordPress's only job is to **supply that tree.** The no-CMS track makes JAB **author its own tree** in a JAB-native vocabulary (`jab/hero`, `jab/feature-grid`, …). Content lives in block attributes (heading text, body copy, image URL), exactly like WP block attrs, so compose bakes it into static TSX.

```
   BRIEF / IMPORTED SITE / WP
        │  (produce a BlockNode[] tree — three ways, §4.1)
        ▼
   BlockNode[] tree   ◄──── chat edits mutate THIS (content) or regenerate a block's component (design)
        │  (deterministic compose — reused)
        ▼
   static TSX ──► build ──► deploy ──► verify ──► review ──► promote
```

Why the IR and not raw-code-as-canon: it reuses ~80% of the pipeline **including** `computeChangedPages` (the block-tree diff that powers the per-page review screen) — which keeps working unchanged because there is still a block tree. Edits stay structured, cheap, and reliable ("change the footer phone #" mutates one attribute, not a grep over code). The trade is a block vocabulary to maintain (§5).

Rejected: "raw code is canon" (AI re-authors free-form TSX each edit) — bypasses compose/inventory/the edit-diff; pricier and driftier as a site grows; the review screen loses its block-tree basis.

### 3.3 `source_type` trichotomy — one pipeline, three front doors

Add `projects.source_type ∈ {wp, url, brief}`. All three converge on the same `page_inventory` + `block_inventory` rows and share everything downstream. They differ *only* in how the tree is produced and what verify scores against.

| `source_type` | How the IR is produced | Verify rubric | Fidelity baseline |
|---|---|---|---|
| `wp` (existing) | WP plugin's block API (structured, typed) | match source | high |
| `url` (import) | Playwright DOM + screenshots → LLM **infers** the JAB block tree | match source | medium (inference is lossy) |
| `brief` (greenfield) | LLM **authors** the tree from a description | match *brief intent* | n/a (no source) |

This reframes WordPress itself: it was never special — it is the **high-fidelity import** (hands you a clean structured tree). `url`-import is the **universal-but-lossy import** (reconstruct the tree from rendered output). Same destination IR, same downstream code.

### 3.4 JAB replaces the CMS, not the app

Positioning, grounded in M-Fit (§7): in any "custom app + headless WP for marketing" stack, WordPress exists to give a non-technical owner an editable marketing surface. That CMS-shaped hole is exactly what the chat-managed-static track fills. The sharpest one-line positioning for the whole track:

> **JAB is a drop-in replacement for headless-WordPress-as-marketing-CMS in custom app stacks.**

JAB does **not** manage app logic (it is not a block tree). The boundary is hard and must be visible in the product (§3.5).

### 3.5 Hosted tier — consolidation, not hosting

A client can own **multiple surfaces of different kinds.** Introduce `projects.kind ∈ {managed, hosted}` and a `clients` grouping layer:

```
tenant (agency)
  └─ client  ("M-Fit")                                   ← new grouping (today: a client_name string)
       ├─ project kind=managed  source=brief/url/wp   → generate + chat-edit pipeline
       └─ project kind=hosted                          → lift-and-shift: connect repo → deploy → done
```

A `kind=hosted` project **reuses the deploy back-half** (`VercelClient`, the existing `githubRepoFullName` / `githubPatEncrypted` columns, env-var sync, `deployments`, domains) and **has no front half** — no discovery, no components, no compose, no chat workspace. Hosting M-Fit's PWA is configuration over existing machinery.

**Hard boundary:** a hosted surface is **not chat-manageable**. The dashboard must gate the chat workspace to `managed` surfaces or the product over-promises.

**Strategic read:** the value is *consolidation* ("every client, every surface, one dashboard, one bill" — the agency-playbook moat), not hosting itself (a commodity wrap over Vercel git-deploy). Guardrails: keep hosted a thin opt-in tier, not the headline; and respect the standing CLAUDE.md failure mode — *"if SaaS work crowds out kit improvements, that's the failure to watch."* Justify the tier by the consolidation pull (M-Fit is real evidence), not by chasing Vercel.

---

## 4. Architecture

### 4.1 Ingest — three ways to produce the tree

```
brief  ──► [LLM authors a multi-page BlockNode[] tree + design tokens + copy]
url    ──► [crawl (nav + sitemap + internal links, BFS, capped) → per page: render + screenshot + DOM]
            └► [LLM: segment into sections → classify each into nearest jab/* archetype → extract content → rehost images]
wp     ──► [existing discover-site: MCP list/by-slug abilities → block trees]            (unchanged)
                          │
                          ▼
        page_inventory (block_tree) + block_inventory   ← identical rows for all three
```

- **`brief`** replaces `discover-site` with a *spec-authoring* worker. Its output contract is the rows the rest of the pipeline already consumes — "authoring" is "produce the same tables `discover-site` produces, from a brief." The existing **anonymous-preview → promote** wow-path is the front door: *describe your site → watch it build live → sign up to keep it.*
- **`url`** reuses the existing Playwright capture (`captureHomepageDesign`, computed-style aggregation, `aggregate-dom-samples`) and adds the genuinely new step: **DOM/screenshot → block-tree inference** (segment → classify → extract). Sections that fit no archetype fall to `jab/custom` passthrough (§5). The crawler (nav + `sitemap.xml` + internal-link BFS, capped) replaces WP's CPT listing as the page-enumeration source.
- **`wp`** is unchanged.

### 4.2 Shared middle — mostly subtraction for `brief`/`url`

| Phase | Change |
|---|---|
| B — components | Reuse. Generate per `jab/*` type. WP host-stripping → no-op for `brief` (no source origin) |
| C — compose | Reuse. **Drop** the SDK / `ROUTE_MAP` / `POST_TYPE_MAP` / `callAbility` page emission — pages are static; content baked from block attrs |
| D — deploy | Reuse. **Drop** the `WP_URL/WP_USER/WP_APP_PASSWORD` env triad; `baseUrl` already falls back to the Vercel URL; image hosts come from JAB Storage/CDN, not `wp_url` |
| E — verify | **Adapt rubric.** `brief` has no source → vision-LLM judges "renders cleanly + matches brand/tone/brief." `url`/`wp` keep pixel-diff-vs-source |
| F — review/promote | Reuse as-is (human gate is pure) |
| Runtime | **Delete** for static (no request-time fetches) |

### 4.3 Chat-edit adaptation

The loop's orchestration, polling, review, and promote are **untouched**. Two adaptations:

1. **A new edit verb.** Today the planner emits `scope ∈ {component, shell}` (design regen). Add **content-mutation** — "change the footer phone number" mutates one block attribute (cheap, deterministic) instead of regenerating a component. The planner gains a verb; the worker gains a branch.
2. **Feed the tree, not WordPress.** `buildSiteMap` reads the (JAB-authored) inventory instead of WP-sourced inventory; `computeChangedPages` diffs the JAB-authored block tree (unchanged logic, different provenance). `regenerateComponentUnit` operates on stored TSX + guidance + screenshot rather than a WP `block_inventory` row's `sourceDomSample`.

### 4.4 The one dynamic wrinkle — opt-in client-side data islands

Most marketing surfaces are fully static, but a few clients have *one* live element (M-Fit's "today's classes" ticker reads Supabase, §7). Rather than abandon "static," support an opt-in **client-side data island**: a `jab/custom` block that is a client component fetching from a client-provided public endpoint. Static by default; a contained escape hatch for the rare live widget. This is an **integration** feature, not a CMS feature.

---

## 5. The Block-tree IR vocabulary

A **curated, extensible** set of section archetypes the authoring/inference LLM composes from, and that Phase B generates one component per. Bounded (unlike WP's open block universe) buys a coherent design system, cacheable component generation (fixed type count), and a planner that always knows what it can change.

Starter set: `jab/hero` · `jab/feature-grid` · `jab/media-text` · `jab/testimonials` · `jab/logo-cloud` · `jab/stats` · `jab/cta-band` · `jab/gallery` · `jab/pricing` · `jab/team` · `jab/faq` · `jab/steps` · `jab/article-list` (static, inline items) · `jab/rich-text` · `jab/contact` — plus the existing `header`/`footer` shell.

- **Extensibility:** new archetypes are additive over time.
- **`jab/custom` escape hatch:** an opaque, separately-regenerated node for sections the vocabulary can't express. Greenfield (`brief`) rarely needs it; it earns its keep for `url`-import (unclassifiable sections) and data islands (§4.4). Coarsely editable by design.
- **Forms:** `jab/contact` is the one place "static" needs a seam. It posts to a tiny serverless action → a JAB `form_submissions` table + email notify. (JAB owns the endpoint, mirroring — but not depending on — the WP track's Gravity Forms work.)
- **Assets/images (default):** client uploads (logo + key photos) → JAB Supabase Storage, with tasteful stock/placeholder fallback for the rest, swappable by chat. AI image-gen is a later nicety.

---

## 6. Data-model evolution

Incremental and well-contained; does not disrupt the managed WP pipeline.

- `projects.source_type ∈ {wp, url, brief}` — default `wp` for existing rows. Meaningful only when `kind=managed`.
- `projects.kind ∈ {managed, hosted}` — default `managed`. A `hosted` row skips all generate phases.
- `clients` table (`id, tenant_id, name`) + `projects.client_id` (nullable FK) — formalizes the `client_name` string into a grouping layer. Dashboard groups projects by client.
- WP discovery artifacts (`page_inventory.{postType, sourceModifiedGmt, blockTree, paradigms}`, `block_inventory.{kind, spec, sourceDomSample}`, `projects.{wp_url, wp_username, wp_app_password_encrypted, wp_plugin_version, manifest}`) become **nullable / unused** for non-`wp` rows. Keep them nullable rather than dropping — preserves one schema across source types and leaves the door open for future multi-source projects.
- `hosted` projects reuse `githubRepoFullName` / `githubPatEncrypted` / `vercelProjectId` / `deployments`; their "build" is a deploy-only path (or native Vercel git CI), no `site_builds` generate phases.

---

## 7. Worked example — M-Fit

`C:\Projects\mfit\docs\design\MFIT_CLAUDE_CODE_HANDOFF.md` describes a Supabase-backed PWA (phone-OTP auth, class scheduling, RSVP/waitlist state machines, check-ins, streaks, realtime messaging, push/SMS/email cascade, Edge Functions, pg_cron). WordPress is in the stack for **one reason** (handoff §14): *"marketing-only pages (About, Testimonials, Pricing, Studio photos)… zero operational data… the PWA pulls WP content read-only via REST."*

Dropping WP and using JAB deletes a whole subsystem:

| M-Fit's WP dependency | Gone with JAB |
|---|---|
| A second WP install + hosting | Owner edits marketing by chatting to JAB |
| ACF + Custom Post Type UI + WP CORS plugins (§14) | No plugin maintenance |
| The `cms.m-fit.studio` domain + `WP_BASE_URL` env (§15) | One fewer system in the stack |
| Runtime REST coupling + `StaleWhileRevalidate` WP caching in the SW (§9) | Marketing is its own static deploy, nothing to fetch |
| Build steps 27–29 (port landing, WP-fetch About/Studio/Testimonials) | Collapses into "JAB owns the marketing surface" |

**Chosen scope (brainstorm 2026-06-10): replace the CMS + host the app.** One JAB *client* ("M-Fit") with two surfaces:
- `kind=managed` — the marketing surface (Landing, About, Studio, Testimonials, Pricing), chat-managed + static. WP deleted.
- `kind=hosted` — the Vite PWA, lift-and-shift Vercel deploy, hosted-but-not-chat-managed.

Both under one domain (marketing apex + app subdomain/subpath) and one dashboard. The PWA gets *smaller* — its `pages/marketing/*` routes and all WP-fetching leave the app.

**The dynamic wrinkle:** the landing-page "today's classes" ticker (handoff step 29) reads Supabase, not WP. Resolution per §4.4: either keep it in the app (clean static/dynamic split) or implement it as a `jab/custom` client-side data island hitting Supabase's public "anyone can read instances" policy.

**Boundary note:** the contested surface is the Landing page (it mixes brochure content with the PWA-install prompt + ticker + "Join" CTA). About/Studio/Testimonials/Pricing are unambiguously JAB-managed. The Landing's "appy" bits either move to the app or become data islands — a per-build decision, not a platform decision.

---

## 8. Decomposition — three buildable pieces

This vision is **three separable specs**, each with its own implementation plan.

| Piece | What | Risk | Serves M-Fit? |
|---|---|---|---|
| **1 — `brief` managed track** | Block-tree IR + `jab/*` vocabulary, brief intake, spec-authoring worker, static emit (drop runtime WP pole), chat-edit content verb, `source_type` discriminator | Medium (IR + authoring are new) | ✅ the marketing site |
| **2 — `url` import track** | Crawler + DOM/screenshot → IR inference, asset rehosting, `jab/custom` passthrough, verify-vs-source for non-WP | High (inference is the hard ML step) | ◐ could import the existing designed pages instead of re-briefing |
| **3 — `hosted` tier + client grouping** | `projects.kind`, `clients` table + `client_id`, deploy-only path, kind-aware dashboard (gate the chat workspace) | Low (config over existing deploy half) | ✅ hosts the PWA |

**Suggested sequence: 1 → 3 → 2.** Prove the managed-static path (1), add the low-risk hosting tier (3), then tackle import (2, highest risk). Piece 3 is low enough risk it could go first if M-Fit is the forcing function. M-Fit specifically needs **1 + 3**; the broader "bring every existing client site" play needs **2**.

Each piece, when greenlit, runs the normal brainstorm → spec → `writing-plans` → execution cycle against its own row above.

---

## 9. Open questions / deferred decisions

1. **Brief intake fields** — exact inputs (description, industry, page list, brand colors/fonts/logo, tone, reference sites). Resolve in Piece 1's spec.
2. **Spec-authoring prompt design** — how one LLM call (or a small chain) produces a *coherent multi-page* site, not N disconnected pages. The core risk of Piece 1.
3. **Inference fidelity ceiling** — how good `url`-import segmentation/classification can get, and where the honest "reconstruction, not clone" line sits. The core risk of Piece 2; the per-page review + fidelity score is the honesty mechanism.
4. **Marketing↔app boundary contract** — for hosted clients, the domain/routing split (apex vs subdomain vs subpath) and how the "Join"-style hand-off is configured. Resolve in Piece 3's spec.
5. **Data-island scope** — whether `jab/custom` client-fetch islands ship in Piece 1 or wait for a real second instance of the need beyond M-Fit's ticker.
6. **Pricing/positioning** — managed vs hosted likely price differently (managed = per-site subscription like the WP track; hosted = thin hosting add-on). Out of scope for the build specs; a product decision.

---

## 10. Anti-goals & guardrails

- **No app management.** JAB never chat-manages auth, databases, realtime, cron, or business logic. The `managed`/`hosted` boundary is hard and visible.
- **No runtime data layer for `brief`.** Shape A is static; resist the drift to "JAB becomes the CMS" unless a separate, deliberate decision reopens it.
- **Hosted stays thin.** It is consolidation glue over Vercel, not a hosting product. Do not let it become the headline.
- **Respect the standing failure mode.** The moat is developer experience + the agency playbook. This track is justified by the agency-consolidation pull (M-Fit is evidence); if it crowds out kit improvements, that is the failure to watch.
- **One schema, many sources.** Keep WP columns nullable rather than forking the schema; the `source_type` discriminator is the seam.
```
