# SaaS MVP transition plan — `apps/web`

> **For the Claude Code session picking this up:** this is both a product-direction
> doc and a remediation plan. It re-points `apps/web` from a *code generator* to a
> *managed headless platform that is also a lightweight CMS*. Build the phases in
> order — [§8 Work order](#8-suggested-work-order). Audit findings from the earlier
> review are folded into the phases with stable IDs; [§6](#6-audit-findings--phase-map)
> is the full reference table. Code snippets are illustrative — confirm against live
> source. Some calls are Sean's, not yours — [§7 Open decisions](#7-open-decisions-for-sean).
>
> Decision date: 2026-05-23 · **Revised 2026-05-23** — added the content-ownership
> model (§3), the onboarding flow (§2), and the fidelity approach (Phase 3).
> Scope: `apps/web` (@jab/web).

---

## 1. The decision

The SaaS as built is a **code generator**: it produces `app/page.tsx` and pushes it to
the agency's GitHub repo. That output only has value to someone who can deploy, host,
wire env vars, and maintain a headless stack — i.e. a developer.

The target customer is **small/medium marketing & web agencies that deliver WordPress
sites and have no React/Next.js developers.** The pitch: keep WordPress as the CMS the
client already knows, get a fast modern frontend, AI does the build and the iteration,
no WP/JS developer required.

Those are different products. **Direction B (chosen): re-point `apps/web` to a managed
headless platform.** The unit of value becomes a *live, hosted, client-presentable
site* — not a code artifact. Headless WP is operationally *heavier* than classic WP
(backend + frontend + deploy + cache + preview); the platform must absorb all of that,
or a no-dev agency has been handed a worse deal than the WP site they already ship.

**Refinement (same day): the MVP is also a lightweight CMS.** Content source is chosen
*per content type* — some content stays in WordPress, some is owned by Jab (see §3).
This is the cleaner architecture for bespoke pages and makes the platform stickier.
"Lightweight" is a hard constraint, not a vibe — the editing surface is the AI
iteration loop, not a WYSIWYG editor.

---

## 2. MVP definition

**Success test:** an agency with no developer connects a client's WordPress site and,
within ~30 minutes, has a faster live site at a real URL they can show the client —
and it stays current when the client edits WordPress.

**In scope for the MVP:**

- Connect WP (probe + onboarding — see the onboarding flow below).
- **Per-content-type ownership** — for each WP post type/taxonomy, the agency picks
  WP-managed or Jab-managed (§3).
- AI generates the site — homepage **plus** the templates that make it a site: a
  generic page, blog index, single post.
- A **fidelity intent** per project — Faithful / Refresh / Reimagine — overridable per
  page (set during onboarding; see the flow below).
- A **lightweight CMS** for Jab-managed content — content documents edited via the AI
  loop (§3).
- The platform **hosts it**. One click → live on a `client.jab.app` subdomain, with a
  path to a custom domain. No GitHub, no Vercel account, no env wiring for the agency.
- WP-managed content **stays live** — when the client edits WP, the headless site
  reflects it (ISR for MVP; webhook revalidation as fast-follow).
- **AI iteration in natural language** — "make the hero bigger," "use their brand
  blue," "add testimonials."
- Preview → publish flow.

**Explicitly cut from the MVP:** GitHub as the primary output (demoted to opt-in
export), a full visual / WYSIWYG / block editor (the *lightweight* CMS in §3 is in
scope — a real editor UI is not), e-commerce/WooCommerce, multilingual, multi-user
tenant invites, white-label. See [§7](#7-open-decisions-for-sean) and [§9](#9-out-of-scope-for-the-mvp).

### The onboarding flow

Designed **value-first** — the user sees a result before the high-friction credential
ask. The app-password is split out of the entry gate: a faithful preview of the public
homepage needs only the URL (public HTML + screenshot + WP core's public REST API).
The app password + the Jab plugin are needed only to pull drafts/ACF/menus and to
establish the live link.

Target flow:

1. **Paste the client's site URL.**
2. **Jab generates a homepage preview** from public data — the wow moment.
3. **Create an account** to save it (lightweight).
4. **Pick the project intent** — Faithful / Refresh / Reimagine.
5. **Assign content ownership** — after the WP probe enumerates post types/taxonomies,
   the agency marks each WP-managed or Jab-managed (§3).
6. **Connect it live** — install the Jab plugin + app password; content goes dynamic.
7. **Review & publish** — preview at breakpoints, tweak in natural language, publish
   to a subdomain.
8. **Expand** — generate the rest of the site's pages/templates.

For the concierge MVP (Phase 0) an operator can walk an agency through a lighter
version of this; the value-first self-serve funnel is the build target, not a Phase 0
blocker. Account creation moving *after* the preview (step 3) is the
conversion-optimized order — see [§7](#7-open-decisions-for-sean).

---

## 3. Content model — WP-managed vs Jab-managed

The infrastructure pillar. Two dimensions, kept separate:

- **Presentation is always Jab.** The rebuilt frontend is the whole product; it never
  goes back to WordPress.
- **Content source is a per-content-type setting**, with two modes:

| Mode | Source of truth | Edited in | Best for |
| --- | --- | --- | --- |
| **WP-managed** | WordPress | wp-admin (client) | Collections the client maintains — blog, portfolio, events, products |
| **Jab-managed** | Jab | the AI iteration loop (agency) | Bespoke marketing pages |

**Rule of thumb:** WP-managed shines for *collections* (many uniform items added over
time); Jab-managed shines for *bespoke pages*. Forcing a custom AI-designed page
through WP would mean modeling every hero/card/CTA slot into ACF fields for someone to
fill in wp-admin — exactly the friction page builders exist to paper over. Jab-managed
pages skip it.

**This makes the MVP a lightweight CMS — and "lightweight" is a hard constraint.**

- What keeps it lightweight: the **editor is the AI iteration loop** (Phase 4) —
  "change the hero headline to X" *is* the editing experience. Storage is a table in
  the Postgres the app already runs. Draft/publish is the preview/publish flow already
  needed for hosting.
- **The scope trap — do not cross it:** no WYSIWYG editor, no Gutenberg-style block UI,
  no media-manager UI in the MVP. If an agency wants to click a headline and type
  inline, that is a fast-follow, not the MVP.

**Data model.** Model a Jab-managed page as a **structured content document** (an
ordered list of sections/blocks, each block a typed set of fields — heading, body,
media refs, etc.) that a component *renders from* — **not** as "the component."

- A **content edit** ("change the headline") mutates the document and re-renders. It
  must NOT regenerate the whole page — that is expensive (an Opus call each time) and
  risks whole-page drift.
- A **design edit** ("make the hero full-bleed") modifies the component.
- Documents are **versioned** so edits are reversible and tie into draft/publish.

New tables (exact schema is a Phase 2 engineering call): a `content_documents` record
per Jab-managed page + a `content_document_versions` history (the structured content
as JSONB). WP-managed types need no new storage — they are pulled from WP at
render/revalidate time.

**Migration is a one-way extraction.** Existing pages live in WP today; choosing
Jab-managed pulls their content into Jab once, and WP's copy goes vestigial. That is a
source-of-truth flip, not a sync — make it deliberate and visible in onboarding.

**Defaults:** collections (posts, CPTs) → WP-managed. Pages → present Jab-managed as
the recommended option with the reasoning, but make it an explicit per-project choice;
never silently flip source-of-truth. Treat the setting as changeable later (post-MVP).

Open sub-questions — boundable, not blocking: media storage for Jab-managed pages
(Jab storage vs. the WP media library), the versioning model, and the
content-document schema. See [§7](#7-open-decisions-for-sean).

---

## 4. What changes vs. today

| Dimension | Today | Target |
| --- | --- | --- |
| Output of a generation | A branch in the agency's GitHub repo | A live preview URL; "publish" promotes it to the site's production URL |
| GitHub | Onboarding step 2 — agency supplies repo + PAT | Removed from the default flow; GitHub becomes an opt-in *export* |
| Content source | Implicitly all-from-WP | Per-content-type: WP-managed or Jab-managed (§3) |
| Content authoring | n/a | Jab is a lightweight CMS for Jab-managed content |
| Onboarding | account → project → WP creds → GitHub → generate | Value-first: URL → preview → account → intent → ownership → connect → publish |
| Generation scope | `app/page.tsx` only | Homepage + generic page + blog index + single post |
| "See the result" | Clone repo, checkout branch, `pnpm install`, `pnpm dev` | Click the preview link |
| Deploy / hosting / env / cache | The agency's problem | Jab's problem — this *is* the product |
| Monetization surface | None | Per-site subscription, plans, quota |

Most of the existing code survives the transition — see [§5 Phase 2](#phase-2--the-hostingruntime-layer-the-product).

---

## 5. The phased plan

### Phase 0 — Concierge validation (run now, in parallel, ~no new code)

The hosting/runtime layer is most of the real product and ~0% of what exists today.
Before building it, validate that agencies will pay and that AI output clears the
"good enough to put in front of a client" bar.

- Use the current SaaS as an internal **operator console**. Operator runs a
  generation, deploys the output manually to a Jab-owned hosting account, hands the
  agency a live link.
- Charge a real per-site setup fee + a small monthly. No self-serve.
- Goal: 5–10 paying agencies; learn the real objections and the quality bar.
- **Test the wedge hypothesis.** Pitch both "a faster, modern site" and "we automate
  your retainer" and listen for which one agencies pull harder for — that signal
  should drive post-MVP roadmap priority (§9).
- A Phase 0 result doubles as the demo asset the landing page badly needs.

This is mostly a go-to-market motion, not an engineering task. No code is required
beyond a one-off deploy script if convenient.

### Phase 1 — Make generation safe to publish (foundation)

Do this before any generated output reaches a client-facing URL. Folds in the audit's
high-severity findings.

- **QUAL-1 — build/typecheck gate.** Nothing currently verifies the AI output
  compiles. Add a worker step between `call-agent` and deploy that runs the generated
  file set through a real `next build` (or at minimum `tsc --noEmit`). A page that
  doesn't compile **fails the job** — it must never be published. Files:
  `lib/inngest/functions/generate-page.ts`.
- **QUAL-2 — honor `stop_reason`.** `lib/ai/agent.ts` returns `stopReason`; the worker
  ignores it. If `stop_reason !== "end_turn"` (e.g. the model hit `MAX_OUTPUT_TOKENS`,
  currently 8192), the TSX is truncated — fail the job instead of publishing partial
  code. Files: `lib/ai/agent.ts`, `lib/inngest/functions/generate-page.ts`.
- **COST-1 — quota + rate limit on generation.** `app/api/projects/[id]/generate/route.ts`
  has no guard; the button's `disabled` state is client-side only. Each generation is
  a paid Opus call. Add a per-tenant concurrency limit and a generation allowance.
  This endpoint becomes the enforcement point for plan limits in Phase 5.
- **SEC-1 — tenant-isolation test + web CI.** There is no automated test and no CI for
  `apps/web` (only `ci-plugin.yml` exists). For a multi-tenant app holding customer WP
  credentials, one RLS slip leaks credentials across tenants. Wire
  `scripts/test-tenant-isolation.sql` into a new `ci-web.yml` alongside typecheck and
  build. Highest-leverage safety net in the doc.
- **SEC-2 — worker must verify `jobId` ↔ `projectId`.** `generate-page.ts` trusts the
  Inngest event's `projectId` unconditionally and never confirms the `generation_jobs`
  row's `project_id` matches. Add that check in `load-context` before any credential
  is decrypted. Files: `lib/inngest/functions/generate-page.ts`, `lib/jab/page-context.ts`.
- **REL-1 — retries + idempotency.** The function is `retries: 0`
  (`generate-page.ts`), which contradicts the stated reason for adopting Inngest.
  Decide the retry policy; if > 0, make the deploy step idempotent. The direct-deploy
  model in Phase 2 makes this easier (no `createRef` 422 on replay).

### Phase 2 — The hosting/runtime layer (the product)

This is the bulk of the build. **Recommended architecture:** the worker assembles the
full file set (reuse `lib/jab/scaffold.ts` + `emitSdk`), then deploys it **directly to
a hosting provider via API** — Vercel for the MVP. No GitHub in the default path.
**Build the deploy step behind a provider seam** (a `DeployProvider` interface, one
Vercel implementation) so the planned Cloudflare migration is one module — the
requirement and reasoning are in [`hosting.md`](hosting.md).

- **Deploy pipeline.** Replace the GitHub push with an "assemble file set → deploy"
  step. `lib/github/push.ts`'s file-tree assembly logic is reusable; only the
  destination changes. Each deploy yields an immutable **preview URL** — that preview
  is the product's "see your site" moment *and* it kills the opaque-wait UX problem.
- **Content-document data model.** Add the `content_documents` + versions tables for
  Jab-managed content (§3). Phase 2 already touches schema (`deployments` below), so
  land the content model here even though it is exercised in Phase 3.
- **WP creds → deployment env.** The deployed site fetches WP-managed content at
  runtime via the generated SDK, which reads WP creds from env (see `scaffold.ts` /
  `renderEnvExample`). Set the decrypted WP creds as deployment env vars. Note this
  data flow deliberately: the WP app password reaches the hosting provider's
  (encrypted-at-rest) env store.
- **Content freshness.** MVP: time-based ISR (e.g. `revalidate: 60`) on WP-managed SDK
  fetches — zero extra moving parts. Fast-follow: a WP-save webhook (small addition to
  the `wp-plugin`) that pings a revalidate endpoint. Jab-managed content revalidates
  on publish.
- **Publish flow.** Each generation = a preview deployment; "publish" promotes it to
  the project's production URL on a `client.jab.app` subdomain, with a custom-domain
  path. New schema: a `deployments` concept (or extend `generation_jobs`) tracking
  preview URL, production URL, status.
- **Demote GitHub.** Remove onboarding step 2: `app/(app)/projects/[id]/onboard/github-form.tsx`,
  `saveGithubAction` + `GithubInput` in `lib/actions/onboarding.ts`, and the GitHub
  branch of `onboard/page.tsx`. Keep `lib/github/push.ts` — it becomes the engine for
  an opt-in "export to your own GitHub" action later.
- **Rework the project UI.** Replace "pushed to branch `jab/home-…`" job rows with
  "preview / published" states and live links. `LocalDevGuide` (clone-and-run
  instructions) becomes irrelevant — remove or repurpose. Files:
  `app/(app)/projects/[id]/page.tsx`, `generation-panel.tsx`, `local-dev-guide.tsx`.

Reused as-is: WP probe + onboarding step 1, credential encryption, the job model, the
scaffold builder, `emitSdk`, and the strangler-fig proxy (`app/[...slug]/route.ts`) —
which remains the incremental-migration story for routes not yet generated.

### Phase 3 — Make it a site, not a page

- **Multi-template generation.** The worker generates only `app/page.tsx` today.
  Generate `app/[slug]/page.tsx` (generic page), `app/blog/page.tsx` (index), and
  `app/blog/[slug]/page.tsx` (single post). The SDK already exposes the abilities;
  the prompt needs a per-template variant. Files: `lib/ai/prompts.ts`, `lib/ai/agent.ts`,
  `lib/inngest/functions/generate-page.ts`, `lib/jab/scaffold.ts`.
- **Per-type ownership routing.** Generated templates fetch WP-managed types from WP
  via the SDK; Jab-managed pages render from their content document (§3). Wire the
  ownership setting through generation.
- **Fidelity approach.** The current pipeline strips styles, feeds the model text-only
  HTML, and the prompt says "don't pixel-match." For migrations agencies want faithful
  rebuilds. Three changes, gated by the project's Faithful/Refresh/Reimagine intent:
  - *Design-token extraction* — load the page in a headless browser and read
    *computed* styles (type scale, spacing, container widths, radii, shadows,
    breakpoints, fonts); compile a Tailwind theme the rebuild is constrained to.
    Strengthens today's brand-color-only extraction in `lib/jab/page-context.ts`.
  - *Screenshot input* — send full-page screenshots (desktop/tablet/mobile) to the
    model alongside content and tokens; the model is multimodal. Files:
    `lib/jab/page-context.ts`, `lib/ai/prompts.ts`.
  - *Visual-diff verification loop* — after deploy, screenshot the rebuild at the same
    breakpoints, diff against the originals, and either auto-iterate or surface an
    old-vs-new comparison to the reviewer. This is the "QA" function and doubles as a
    fidelity report. Honest framing: target client-sign-off fidelity, not literal
    pixels; never promise "pixel-perfect."
- **Forms answer.** Every SMB site has a contact form, and headless breaks WP forms.
  MVP: leave form pages on the strangler-fig proxy fallback (it already forwards
  unmatched routes to WP). Fast-follow: a real form handler.
- **Site-level view.** The project page should show the site's pages/templates and
  migration coverage, not just a flat job log.

### Phase 4 — AI iteration loop

- **Natural-language refinement.** Let the user submit feedback on a generated page.
  For Jab-managed content, a content edit mutates the **content document** and
  re-renders — it does not regenerate the whole page (§3). A design edit modifies the
  component. `generation_jobs` / content versions gain parent/iteration linkage.
- **Preview vs. publish in the UI.** Each iteration is a new preview deployment;
  publish promotes the chosen one. This plus Phase 2's preview URLs fully resolve the
  product audit's "no preview" and "opaque wait" findings.

### Phase 5 — Monetization

- **Plans + subscriptions.** Stripe. Recommended shape: a per-site recurring fee sold
  in 2–3 agency tiers, plus a per-site setup fee; bill the **agency**, not the end
  client; a free **trial** (one site, time-boxed) rather than a free tier; bundle a
  generous AI generation allowance rather than metering tokens. New tables for
  plans/subscriptions (or a billing-provider source of truth mirrored locally).
  Positioning (premium vs. accessible) and the actual numbers are open — [§7](#7-open-decisions-for-sean).
- **Quota enforcement.** Wire Phase 1's COST-1 guard to plan limits — site count and
  generation allowance. Gate project creation and generation on the active plan.
- **Billing surface** in the app.
- **COST-2 — model cost lever.** `lib/ai/agent.ts` hardcodes `claude-opus-4-7` for
  every generation. Now that hosting + inference are real COGS, re-test Sonnet vs Opus
  on `scripts/validate-ai` — gross margin depends on bounded AI spend per site.

### Cross-cutting polish (slot in anywhere)

- **Landing page.** `app/page.tsx` is a placeholder; the headline "WordPress is just a
  blog" is inaccurate and slightly insulting to the WP-agency audience. Rewrite around
  the agency pitch with a real demo (a Phase 0 concierge result).
- **Wait-state UX.** Surface the worker's named steps as progress instead of a bare
  "Generating…". `generation-panel.tsx`.
- **"Get started" → sign-up.** The landing CTA lands on the *Sign in* form;
  new users must spot the small "Create one" link. Default to sign-up mode.
  `app/(auth)/sign-in/sign-in-form.tsx`.
- **Connections/settings view.** Let an agency see and refresh WP credentials without
  re-running the whole wizard; today a stale credential surfaces only as a job failure.
- **Jargon.** Translate "abilities / manifest / probe" into outcomes in UI copy
  ("found 14 content types: posts, pages, events…").
- **DEBT-1 — Drizzle is dead code at runtime.** `dbAdmin()` and `lib/db/schema.ts` are
  never imported; all DB access goes through supabase-js, and the migrations are
  hand-authored SQL. Decide before Phases 2 & 5 add tables: either adopt Drizzle as
  the real query layer + migration source, or delete `lib/db/*` and own the SQL
  migrations as the single source of truth.
- **SEC-3 — SSRF.** The worker fetches user-supplied `wp_url` (`fetchRawHtml`,
  `wpFetchJson` in `lib/jab/page-context.ts`; `probeWordPress`). Add host
  validation/allowlisting before self-serve signups open.
- **API auth semantics.** Unauthenticated API calls get a 302 redirect to `/sign-in`
  (HTML) instead of a 401. `middleware.ts`.
- **Security headers** are absent in `next.config.ts`.

---

## 6. Audit findings → phase map

| ID | Severity | Finding | Phase | Primary files |
| --- | --- | --- | --- | --- |
| QUAL-1 | High | Generated code is never compiled before use | 1 | `lib/inngest/functions/generate-page.ts` |
| QUAL-2 | High | Truncated generation (`stop_reason`) published as success | 1 | `lib/ai/agent.ts`, `generate-page.ts` |
| COST-1 | High | No quota / rate limit on the paid generation endpoint | 1 → 5 | `app/api/projects/[id]/generate/route.ts` |
| SEC-1 | High | No automated tenant-isolation test; no web CI | 1 | `scripts/test-tenant-isolation.sql`, `.github/workflows/` |
| SEC-2 | Medium | Worker trusts event `projectId`; no `jobId` cross-check | 1 | `generate-page.ts`, `lib/jab/page-context.ts` |
| REL-1 | Medium | `retries: 0` vs. Inngest rationale; push not idempotent | 1 → 2 | `generate-page.ts` |
| COST-2 | Medium | Opus on every generation — model cost lever | 5 | `lib/ai/agent.ts` |
| DEBT-1 | Medium | Drizzle is a dead second source of truth | Cross-cutting | `lib/db/*` |
| SEC-3 | Low/Med | SSRF — worker fetches user-supplied `wp_url` | Cross-cutting | `lib/jab/page-context.ts`, `lib/jab/probe.ts` |
| UX-1 | Medium | Opaque 60–120s wait; no progress | 2 + 4 (preview URLs) | `generation-panel.tsx` |
| UX-2 | Medium | No in-app preview of the generated site | 2 (solved by hosting) | — |
| UX-3 | Low | "Get started" lands on Sign in, not Sign up | Cross-cutting | `sign-in-form.tsx` |
| PROD-1 | High | Landing page can't convert | 0/Cross-cutting | `app/page.tsx` |
| PROD-2 | High | No pricing / billing — v0 can't measure revenue | 5 | new |

---

## 7. Open decisions for Sean

These are product/business calls a coding session should not make alone:

1. ~~**Hosting provider**~~ **RESOLVED 2026-05-23 — Vercel for the MVP**, Cloudflare as
   the planned scale target. Full reasoning, cost analysis, and the **provider-seam
   requirement Phase 2 must implement** are in [`hosting.md`](hosting.md).
2. **Pricing positioning** — the model is settled (per-site recurring in agency tiers
   + setup fee, bill the agency, trial not free tier — Phase 5). Still open: **premium
   vs. accessible** positioning, and the actual numbers/tier breakpoints.
3. **Run the Phase 0 concierge motion?** Recommended — validate willingness-to-pay and
   the quality bar before building the hosting layer.
4. **Hosting domain + custom-domain story** — `client.jab.app` subdomains for the MVP;
   when/how custom domains come in.
5. **Keep GitHub export in the MVP at all,** or defer it entirely to post-MVP.
6. **Media storage for Jab-managed content** — Jab-side storage (e.g. Supabase Storage)
   vs. continuing to reference the WP media library. Affects §3's data model.
7. **Default content ownership for pages** — Jab-managed is recommended (§3); confirm
   that is the default the onboarding step suggests.

---

## 8. Suggested work order

1. **Phase 0** — concierge validation, in parallel, starting now.
2. **Phase 1** — generation-safety foundation. **Gates Phase 2** — never deploy
   unvalidated AI output to a client-facing URL.
3. **Phase 2** — the hosting/runtime layer + the content-document data model.
4. **Phase 3** — multi-template generation, per-type ownership routing, fidelity, forms.
5. **Phase 4** — AI iteration loop.
6. **Phase 5** — monetization.

Cross-cutting polish slots in opportunistically; DEBT-1 should be decided before
Phases 2 and 5 add database tables.

---

## 9. Out of scope for the MVP

Multi-user tenant invites (the schema already supports it — not MVP-critical),
page-builder sites (Elementor/Divi store design as builder markup, not structured
content — **explicitly target ACF/CPT-driven, cleanly-themed sites** and say so),
e-commerce/WooCommerce, multilingual, a full visual / WYSIWYG / block editor (the
lightweight CMS in §3 *is* in scope — a real editor UI is not), and white-label.

**Post-MVP roadmap (separate track, not specced here):** the "AI agency team" — Content,
SEO, Security/maintenance, and QA modules, framed as the roles an agency can't afford
to hire. Phase 0's wedge test should drive which module comes first. Each is real
future work; each obscures the MVP wedge if touched now.

## 10. Extraction & accuracy pipeline (added 2026-05-23)

Drawn from a competitive review of Replit's `extracted-content-example.md` +
`extracted-design-example.json` (now in [`docs/replit-examples/`](replit-examples/));
the full design-side learnings are in the plan file's §15. This section is the
engineering-side breakdown — what we extract today, what we don't, and how to ensure
accuracy on what's next.

### Current state

The platform has **two extraction stages**; only one is real today.

| Stage | What it does | Status |
|---|---|---|
| **Stage 1** — public-HTML scrape at `/preview` (pre-auth) | Generate the wow preview from rendered HTML | **Mocked.** [`apps/web/app/preview/preview-flow.tsx`](../apps/web/app/preview/preview-flow.tsx) is a `setTimeout` chain that builds a placeholder homepage from the pasted URL. No real generator. `lib/ai/scrape-agent.ts` is the engineering ticket. |
| **Stage 2** — `probeWordPress` via `fetchManifest` (post-auth, plugin + app password) | Discover the WP install's ability catalog | **Real.** [`apps/web/lib/jab/probe.ts`](../apps/web/lib/jab/probe.ts) → [`packages/core/src/manifest.ts`](../packages/core/src/manifest.ts). Returns canonical JSON Schemas verbatim from WP-REST. No LLM in the loop. |

**Accuracy posture today:**

- **Stage 2 is high-accuracy by design.** WP/the plugin authors the schemas; we
  persist them verbatim with no transformation or LLM interpretation. Failures are
  loud (`McpClientError` with the actual cause). Stage 2 doesn't need confidence
  scores because there's no inference.
- **Stage 1 is a UX lie.** The `/preview` "wow" surface promises a generated
  homepage from the user's URL and delivers a generic Acme-Coffee placeholder.
  This is the single largest accuracy issue on the product — it sets the wrong
  expectation for the rest of the flow.
- **No design-context extraction anywhere.** Stage 2 captures the *content
  catalog* (post types, ACF fields, taxonomies) but zero design signal. Replit's
  `extracted-design-example.json` captures 13 design fields the AI worker would
  benefit from at generation time: brand colors, font families with roles
  (heading vs body), typography scale, per-corner border-radius, logo +
  favicon + OG image as files, an LLM-classified primary/secondary button pair,
  and a `personality` block (tone / energy / target audience). Today our worker
  has to infer all of this from a screenshot at generation time, which is
  high-variance.

### What the competitive review tells us about accuracy mechanisms

Replit's design-extract JSON shows three patterns worth importing — they're
specifically the *accuracy guarantees* of an LLM-in-the-loop extraction pipeline:

1. **Confidence scores per dimension.** `confidence: { buttons: 0.95, colors: 0.9,
   overall: 0.925 }`. Below-threshold values can be flagged in the UI as "review
   this." Without numeric confidence, the system either over-trusts an
   uncertain extraction or quietly rejects a high-confidence one.
2. **Persist LLM reasoning alongside selections.** `__llm_logo_reasoning` and
   `__llm_button_reasoning` blocks store the *why* ("Selected #0 because it is
   visible, links to the homepage, and matches the brand's favicon and
   identity"). Audit trail + agency trust + debuggability when a generation
   goes sideways.
3. **Distinct LLM passes per concern.** Separate calls for logo-selection,
   button-classification, personality-inference. Each call has its own
   confidence + reasoning. Not one giant prompt that returns everything.

These are imported by reference from the design plan's §15. The engineering
work below assumes they're the right shape.

### Engineering work items

**Stage 1 — `PublicScrapeGenerator` (the unblocking ticket).** Land
`apps/web/lib/ai/scrape-agent.ts` to replace the mock in
[`apps/web/app/preview/preview-flow.tsx`](../apps/web/app/preview/preview-flow.tsx).
Pipeline:
1. Fetch raw HTML at the submitted URL (timeout, max-size, follow-redirects-limit).
2. Parse with a lightweight DOM parser (Cheerio). Extract: title, meta
   description, primary heading candidates, image URLs, nav links, footer
   text, dominant colors (from inline CSS + sampled image regions).
3. Run **two separate LLM passes**, mirroring Replit's pattern:
   - **Content pass:** sections / heading hierarchy / content priority → markdown.
   - **Design pass:** colors / fonts / button classification / logo selection /
     personality → JSON with per-field `confidence` + `reasoning`.
4. Persist both as files on the `anonymous_previews` row (§12 step 2 of the
   design plan). The markdown is the human-readable audit trail; the JSON
   drives the AI generation.
5. The wow generation prompt consumes both — content for what to render,
   design for how to style.

Phase target: **Phase 2** (Hosting/runtime). The preview surface is the
"see your site" moment per §2; the mocked version is currently the loudest
honesty gap.

**Stage 2 — Augment the manifest with design context.** Today the manifest is
WP-content-only. Add an asynchronous LLM-extraction pass triggered post-probe:
1. Fetch a render of the WP homepage (plugin can render `/?preview=1` or we
   pull the live homepage HTML — engineering call).
2. Run the same two-LLM-pass extraction as Stage 1 against the rendered HTML.
3. Persist as `projects.design_tokens` (JSONB) + `projects.personality` (JSONB)
   with confidence + reasoning per field.

The contract: by the time the user reaches the workspace, both the *catalog*
(Stage 2 today) and the *design context* (this addition) are persisted. The AI
generation worker reads both as input, not just the catalog + screenshot.

Phase target: **Phase 3** (Make it a site, not a page). Per-template generation
depends on design context being available, so this lands alongside the
Blog/Single/Generic template work.

**Asset capture.** Save logo + favicon + OG image as files (not URLs that can
404). Stored alongside the project — engineering picks the storage layer
(Supabase Storage is the obvious one). Required for the generated site to ship
the right favicon and OG image without re-fetching at every render.

Phase target: **Phase 2** (alongside Stage 1 scrape — same fetch round-trip).

**Confidence threshold surfacing.** Below ~0.7 on any field, the workspace
should surface a "review this" affordance. Below ~0.4, refuse to use the value
in generation and ask the user. UI side already designed in the plan's §15
("Why this?" disclosure pattern).

Phase target: **Phase 3** (workspace IA).

### Priority order

1. ✅ **Land `scrape-agent.ts`** — the `/preview` lie is the loudest accuracy gap.
   Unblocks the wow path and sets the pattern for the rest. **Done 2026-05-23**
   (commits `0b91e95` + `6ea73bd`): scrape-fetch + scrape-extract + scrape-prompts
   + scrape-agent + render-prompts + preview-renderer + scrape-preview Inngest
   worker + rate-limit + public-error mapping. Closed by **2026-05-26** with
   promote-on-signup + prune cron — the wow path now goes browser → preview →
   signup → real project under the new tenant, fully atomic.
2. **Asset capture in Stage 2** — small scope, immediate visible win (clients
   see their real favicon on the generated site). **Next up.**
3. **Design-context augmentation in Stage 2** — feeds the per-template
   generation work in Phase 3 and the FidelityReport accuracy.
4. **Confidence threshold surfacing in the workspace** — once the per-field
   confidence values exist in the data layer, the UI work is small.

### What we explicitly don't import from Replit's pipeline

- **Credit-economy framing on extracted-fields screens** (their JSON has a
  metering posture; ours doesn't need it — see plan §15 #5 in the "Don't
  adopt" list).
- **Single-pass mega-prompt** for everything. Replit's separation of concerns
  (logo / button / personality each its own LLM call) is correct; we should
  match it, not regress to a single prompt.
- **Bootstrap-framework detection** (`designSystem: { framework: "bootstrap" }`
  in their JSON). Replit needs to know the framework to clone it; we always
  emit Next.js + Tailwind regardless of the source site's framework, so
  detecting it is wasted inference.

### References

- Plan §15 — design-side learnings (UI patterns, "Why this?" disclosure,
  conversational fidelity copy).
- [`docs/replit-examples/`](replit-examples/) — the source JSON + markdown +
  screenshots this section is drawn from.
- [`apps/web/lib/jab/probe.ts`](../apps/web/lib/jab/probe.ts) — current Stage 2
  entrypoint.
- [`packages/core/src/manifest.ts`](../packages/core/src/manifest.ts) — the
  manifest discovery flow this augmentation extends.
