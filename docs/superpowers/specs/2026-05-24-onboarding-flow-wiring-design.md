# Onboarding flow wiring — design

> Spec for wiring the existing `OnboardingWizard` component into the real
> authenticated flow, plus the dashboard/workspace updates needed to support
> projects mid-onboarding.
>
> Date: 2026-05-24 · Scope: `apps/web` (@jab/web) · Reads against
> [`docs/saas-mvp-transition.md`](../../saas-mvp-transition.md) §2 (the
> canonical onboarding flow) and [`docs/jab-brand.md`](../../jab-brand.md)
> (visual conventions).
>
> **Status: shipped 2026-05-24.** Commits `ea1dc2f` (feature), `e1d504d`
> (code-review follow-ups: SSRF guard on `connectWpAction`, RLS row
> confirmation on `completeOnboardingAction`, dead-code deletion of
> `probeAndSaveWpAction`, status drift guard). Migration 0011 applied to
> both `celzwcxkrmsbwiswkxug` (jab-prod) and `ajfurojjxthhzkjqttri`
> (legacy JAB WP). Two as-built drifts from this spec: (a) `connectWpAction`
> replaced the FormData-typed `probeAndSaveWpAction` rather than wrapping
> it — the old action had no other callers after the form deletion;
> (b) `OnboardingShell` got an `aside` prop because the route's `cn()`
> utility is plain concatenation, not twMerge, so overriding `max-w-2xl`
> from outside wasn't reliable.

---

## 1. The problem

[`docs/saas-mvp-transition.md`](../../saas-mvp-transition.md) §2 spells out
the canonical onboarding flow steps 1–8. Steps 1–3 (paste URL → preview →
signup) ship today via [`/preview`](../../../apps/web/app/preview/) +
[`promote_anonymous_preview()`](../../../apps/web/drizzle/migrations/0007_promote_preview.sql).
The post-signup `OnboardingWizard` component
([`components/onboarding-wizard.tsx`](../../../apps/web/components/onboarding-wizard.tsx))
covers steps 4–6 — **but it's only mounted at the dev-only
[`/ui-kit/onboarding`](../../../apps/web/app/ui-kit/onboarding/) demo route.**
It's never wired into the real flow.

The consequence: a freshly-signed-up user is dropped at
[`/projects/[id]`](../../../apps/web/app/(app)/projects/[id]/page.tsx) — the
rich JAB Site Detail workspace — for a project that has no intent, no WP
connection, no manifest, and no ownership map. The workspace renders mock
Lighthouse scores, a mock "● Connected" WordPress card, and mock deploy
history because those data sources aren't wired yet
(see [`./mocks.ts`](../../../apps/web/app/(app)/projects/[id]/mocks.ts)). The
workspace pretends the user has finished onboarding when they haven't even
started it.

This spec is the wiring that closes that gap.

---

## 2. What changes — at a glance

| Surface | Today | After |
|---|---|---|
| `/sign-in` / `/sign-up` post-promote redirect | `/projects/{id}` | `/projects/{id}/onboard` |
| `/auth/callback` post-promote redirect | `/projects/{id}` | `/projects/{id}/onboard` |
| `/projects/new` createProject server action | `/projects/{id}` | `/projects/{id}/onboard` |
| `/projects/[id]/onboard` page | Old WP-creds + GitHub forms (`WpCredsForm` + `GithubForm`) | The `OnboardingWizard`, with project state hydrated from the row |
| `/projects/[id]` workspace | Always shows the rich mocked workspace | Same shell, draft-aware: prominent "Resume setup" banner + empty states on cards that need connected data |
| `/dashboard` rows | Status badge + link to workspace | Same shell with a step-aware status badge ("Setup • Step 2 of 4") on draft/onboarding projects |
| `projects` table | No `intent` / `content_ownership` / `preview_html` columns | One new migration adds them |
| `promote_anonymous_preview()` PG function | Inserts the project, doesn't copy the wow HTML | Same — preview HTML is copied via a follow-up UPDATE in the calling server action (keeps the function focused on the atomic claim-and-create) |

---

## 3. The user-side flow, post-wiring

**Sarah (new user, came via `/preview`):**
1. `/preview` → wow iframe rendered. Clicks "Save your preview →".
2. `/sign-up?from=preview` → creates account.
3. `promoteAnonymousPreviewIfPresent()` runs, creates a `projects` row with
   `status='draft'`, copies `generated_html` → `projects.preview_html`.
4. **NEW:** redirects to `/projects/{id}/onboard`.
5. Wizard opens at step 0 (Intent). To her right, a thumbnail of the
   preview she just saved. "Saved! Pick an intent so we know how closely
   to match the original."
6. Picks Faithful → Continue → `saveIntentAction` persists, advances to
   plugin step.
7. Installs the plugin → Continue → connect step.
8. Submits WP creds → `probeAndSaveWpAction` (already exists) runs probe,
   persists manifest, advances to ownership step.
9. Assigns ownership for each content type → Finish setup →
   `completeOnboardingAction` persists `content_ownership`, flips
   `status='ready'`, redirects to `/projects/{id}`.
10. Workspace renders without the banner. Preview card uses
    `preview_html`. WP Connection card uses the real probed data. AI
    iteration loop unlocks (still wired to "coming soon" mocks until
    Phase 4).

**Sarah, day 2, returning to a half-done onboarding:**
1. `/sign-in` → no preview cookie, signs in → `/dashboard`.
2. Dashboard row shows "Setup • Step 3 of 4" badge with warning tone.
3. Clicks row → `/projects/{id}` (workspace).
4. Banner across the top: "Finish setting up Two Roads Brewing. You're 2
   of 4 steps in. *[Resume setup →]*"
5. Clicks → `/projects/{id}/onboard`.
6. Wizard auto-resumes at step 3 (Ownership) because intent and manifest
   are already persisted.

**Alex (from-scratch project, no preview):**
1. `/dashboard` → New project → `/projects/new`.
2. Fills name + client + WP URL → submits.
3. createProject inserts row, **NEW:** redirects to
   `/projects/{id}/onboard` (not `/projects/{id}`).
4. Wizard opens at step 0. Preview pane is empty (no `preview_html` to
   show). Same flow from there.

---

## 4. Schema — one migration

`apps/web/drizzle/migrations/0011_project_onboarding_state.sql`:

```sql
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS intent             TEXT
    CHECK (intent IN ('faithful', 'refresh', 'reimagine')),
  ADD COLUMN IF NOT EXISTS content_ownership  JSONB,
  ADD COLUMN IF NOT EXISTS preview_html       TEXT;

COMMENT ON COLUMN public.projects.intent IS
  'Project intent (Faithful / Refresh / Reimagine). NULL until the user finishes step 0 of onboarding.';
COMMENT ON COLUMN public.projects.content_ownership IS
  'Per-content-type ownership map { "<slug>": "wp-managed" | "jab-managed" }. NULL until the user finishes step 3 of onboarding.';
COMMENT ON COLUMN public.projects.preview_html IS
  'Promoted-from-anonymous-previews wow HTML. Rendered in the workspace preview card and in the wizard preview pane until the first real deploy supersedes it.';
```

Constraint notes:
- `intent` is nullable (NULL = "user hasn't picked yet"). The check
  constraint keeps the three allowed values explicit. Strings (not an
  enum type) so a future fourth intent doesn't need a schema migration —
  just a constraint update.
- `content_ownership` is a JSONB map of `slug` → `"wp-managed" | "jab-managed"`,
  shape derived from [`OwnershipMode`](../../../apps/web/components/ownership-picker.tsx).
- `preview_html` is TEXT (no size cap). The wow renderer caps output at
  `MAX_OUTPUT_TOKENS = 16384` ([commit `c19f67c`](../../../apps/web/lib/ai/preview-renderer.ts)),
  which is comfortably under any practical TEXT limit.

**Status column semantics** (no migration needed — the existing
`draft | onboarding | ready | archived` enum holds):
- `draft` — project exists, user hasn't started the wizard
- `onboarding` — any of (intent, manifest, content_ownership) is set, but
  not all three. (Status is the **explicit** signal; the column presence
  is the **derived** signal. Both stay in sync via the server actions.)
- `ready` — all three set; wizard's `onComplete` flipped status here
- `archived` — unchanged

---

## 5. Server actions

### 5.1 — Modify `promoteAnonymousPreviewIfPresent` to copy preview HTML

[`lib/actions/promote-preview.ts`](../../../apps/web/lib/actions/promote-preview.ts):
after the `promote_anonymous_preview()` RPC returns the new `projectId`,
do an RLS-scoped UPDATE setting `projects.preview_html = previewRow.generated_html`.

The previous design comment in that file ("the workspace re-generates
from real connected-WP data once stage-2 probe runs — the preview was the
'wow,' the project is the real thing") now reads as misleading. Update
the JSDoc to: "the preview HTML lives on the project through onboarding
as user-facing context; the first real deploy supersedes it."

The atomic Postgres function itself ([migration 0007](../../../apps/web/drizzle/migrations/0007_promote_preview.sql))
stays untouched. Keeping the claim-and-create atomic doesn't require
copying the HTML in the same transaction — if the follow-up UPDATE fails
the project is still created and the user can recover (the wizard's
preview pane just won't render the thumbnail).

### 5.2 — `saveIntentAction(projectId, intent)`

New action in `lib/actions/onboarding.ts`. Persists `intent`, flips
`status = 'onboarding'` if it was `'draft'`. RLS-scoped (the auth check
is implicit via `createClient()` → the row only updates if the user owns
the project's tenant). Returns `{ error?: string }`.

### 5.3 — `verifyPluginAction(projectId)`

New action. Reads `wp_url` from the project row (RLS-scoped), GETs
`{wp_url}/wp-json/jab/v1/` with a 5s timeout, returns `{ ok: boolean; message?: string }`.
Reuses the same SSRF guard as [`lib/ai/ssrf-guard.ts`](../../../apps/web/lib/ai/ssrf-guard.ts)
because the URL is user-supplied (even though we've stored it, the user
could have edited it). Wired to the wizard's `onVerifyPlugin` prop.

### 5.4 — `completeOnboardingAction(projectId, ownership)`

New action. Persists `content_ownership`, flips `status = 'ready'`, sets
`onboarded_at = NOW()`. RLS-scoped. Redirects (`next/navigation` redirect)
to `/projects/{id}`. The `onComplete` callback on the wizard awaits this.

### 5.5 — Remove `saveGithubAction` + `GithubInput`

[`lib/actions/onboarding.ts`](../../../apps/web/lib/actions/onboarding.ts):
delete the bottom half of the file. The transition doc §5 Phase 2
explicitly demotes GitHub from onboarding. No remaining caller after the
route change in §6 below.

### 5.6 — Modify `createProject` to redirect to onboarding

[`lib/actions/projects.ts`](../../../apps/web/lib/actions/projects.ts):
change the final `redirect(\`/projects/${project.id}\`)` →
`redirect(\`/projects/${project.id}/onboard\`)`.

---

## 6. Routes & components

### 6.1 — `/projects/[id]/onboard` page

[`app/(app)/projects/[id]/onboard/page.tsx`](../../../apps/web/app/(app)/projects/[id]/onboard/page.tsx):
**replace contents.** Becomes a Server Component that:

1. Reads `id, name, wp_url, intent, manifest, content_ownership, status, preview_html, design_tokens`
   from the project (RLS-scoped; PGRST116 → notFound).
2. If `status === 'ready'`, `redirect("/projects/{id}")` — user shouldn't
   re-enter the wizard. (The doc currently says the opposite is OK
   because re-running was the way to update GitHub creds; that
   justification is gone with GitHub demoted.)
3. Derives `initialStepIndex` from the persisted state:
   - `intent === null` → 0 (Intent)
   - `intent !== null && manifest === null` → 1 (Plugin)
   - `manifest !== null && content_ownership === null` → 3 (Ownership)
   - (Edge case: if intent + manifest but no ownership AND user explicitly
     navigates back, they get steps 0/1/2 with "done" status in the
     stepper and clicking through doesn't re-prompt.)
4. Renders the wizard with an optional preview pane:
   - The pane is implemented as a new `aside` prop on
     [`OnboardingShell`](../../../apps/web/components/ui/onboarding-shell.tsx).
     The shell renders a 2-column layout when `aside` is set
     (`max-w-2xl` for the column, plus a `lg:`-only right column for the
     aside) — below `lg:` the aside collapses underneath the wizard so
     step actions stay in thumb-reach.
   - The route passes `<PreviewFrame srcDoc={preview_html} … />` as the
     `aside` when `preview_html` is non-null. From-scratch projects pass
     no aside; the shell falls back to today's centered layout.
   - This shape (`aside` on the shell) avoids fighting the existing
     `max-w-2xl` from the outside — `cn()` is plain concatenation, not
     twMerge, so a route-level wrapper can't reliably override the
     shell's max-width.
5. The wizard's `wpUrl` prop = `project.wp_url`.
6. Client-side `<OnboardingWizardClient>` wrapper turns the four server
   actions into the function-shaped props the wizard expects:
   - `onSaveIntent(intent)` → calls `saveIntentAction(projectId, intent)`
   - `onConnect(creds)` → calls `probeAndSaveWpAction` with a FormData
     adapter (the existing action takes FormData per its `_prev, formData`
     useActionState signature; the wizard hands us a plain object)
   - `onVerifyPlugin()` → calls `verifyPluginAction(projectId)`
   - `onComplete({ intent, ownership })` → calls
     `completeOnboardingAction(projectId, ownership)` (intent is already
     persisted incrementally; ignored at completion)

Delete:
- [`app/(app)/projects/[id]/onboard/wp-creds-form.tsx`](../../../apps/web/app/(app)/projects/[id]/onboard/wp-creds-form.tsx)
- [`app/(app)/projects/[id]/onboard/github-form.tsx`](../../../apps/web/app/(app)/projects/[id]/onboard/github-form.tsx)

### 6.2 — `OnboardingWizard` component additions

[`components/onboarding-wizard.tsx`](../../../apps/web/components/onboarding-wizard.tsx):
two new props.

- `initialStepIndex?: 0 | 1 | 2 | 3` — defaults to `0`. The route page
  passes the derived value so resume lands the user where they left off.
- `onSaveIntent?: (intent: ProjectIntent) => Promise<void>` — optional
  callback fired when the user clicks "Continue →" on step 0. The wizard
  awaits it before advancing; on rejection it surfaces the error like
  the connect step already does (a new `intentError` Alert at the top
  of step 0). If not provided, the wizard skips the persist and just
  advances — preserves the ui-kit/onboarding demo's behavior.

The wizard's local `intent` state persists alongside the saved value; if
the user goes back to step 0 they see their choice still selected and
re-clicking Continue is a no-op re-save (the server action is
idempotent).

The demo at [`app/ui-kit/onboarding/onboarding-demo.tsx`](../../../apps/web/app/ui-kit/onboarding/onboarding-demo.tsx)
gets a mock `onSaveIntent` so the demo exercises the new path.

### 6.3 — `/projects/[id]` workspace page (draft-aware)

[`app/(app)/projects/[id]/page.tsx`](../../../apps/web/app/(app)/projects/[id]/page.tsx):
extend the existing Server Component.

**Query additions:** select `intent, manifest, content_ownership, preview_html, design_tokens, personality` in addition to today's columns.

**Banner:** If `status !== 'ready'` AND `status !== 'archived'`, render a
new `<OnboardingResumeBanner>` between the topbar and the site header.
Visual: full-width, teal-tinted, status-dot pulse on the left. Copy:

> **Finish setting up {name}.** You're {N} of 4 steps in — {next-step
> hint}. *[Resume setup →]*

`N` = count of (intent ? 1 : 0) + (manifest ? 1 : 0) + (content_ownership ? 1 : 0).
Next-step hint:
- N=0: "pick a project intent"
- N=1: "install the Jab plugin"
- N=2: "connect for the live data sync"  (note: plugin install isn't
  persisted state — if intent is set we assume the user is past it on
  resume; the next step is connect)
- N=3: "decide where each content type lives"

The button links to `/projects/{id}/onboard`.

**Preview card:** if `preview_html` is non-null, set the iframe's
`srcDoc` to it. Replace today's dotted-grid placeholder. Caption changes
from generic to "Preview from your wow generation. Will refresh on first
deploy."

**Card empty states** (when status !== 'ready'):
- **Lighthouse perf grid** — four "—" placeholders with row caption
  "Available after first deploy."
- **WordPress Connection card** — if `manifest === null`, replace the
  "● Connected" badge with "● Not connected", swap the rows for a single
  centered "Connect Jab to the live WordPress site to see content
  types." with a Connect → button to the wizard. If `manifest` is
  present, use real data (drop `SITE_DETAIL_MOCKS.wpConnection` for this
  branch).
- **Deploy History card** — render empty state "No deploys yet. Finish
  onboarding and we'll cut your first preview deploy."
- **AI Update card** — textarea stays disabled; placeholder changes to
  "Connect for live data to start iterating."

When `status === 'ready'`, the banner is hidden and cards fall back to
today's mocks (`SITE_DETAIL_MOCKS`) — replacing those with real data is
out of scope for this spec (Phase 2 deployments work). The point of this
spec is the **onboarding wiring**, not real-data backing.

### 6.4 — `/dashboard` rows (status-aware)

[`app/(app)/dashboard/page.tsx`](../../../apps/web/app/(app)/dashboard/page.tsx):

- Add `intent, manifest, content_ownership` to the query so we can
  derive the step count without an extra round trip.
- Change `ProjectStatusBadge` to render step-aware copy for
  `draft`/`onboarding` rows: `Setup • Step N of 4`. Compute N the same
  way as the workspace banner. Status badge for `ready` stays unchanged.
- Row click target stays `/projects/{id}` — the workspace banner is the
  one consistent destination for "do something with this project."

---

## 7. Edge cases

### 7.1 — User navigates directly to `/projects/[id]/onboard` for a ready project
The route Server Component sees `status === 'ready'` and redirects to
`/projects/{id}`. They don't get a wizard for a finished project.

### 7.2 — User reloads the wizard mid-flow
The route reads persisted state on every request and derives
`initialStepIndex`. State survives reloads automatically.

### 7.3 — Two browser tabs open the wizard
Both render off the same persisted state. Whichever tab clicks "Continue"
on the intent step first persists the value; the other tab's "Continue"
either persists the same value (idempotent) or a different one (last
write wins). Acceptable — single-user contention.

### 7.4 — `promote_anonymous_preview()` runs but the follow-up `preview_html` UPDATE fails
The project exists; the wizard renders without the preview thumbnail
pane. Soft failure mode. We don't roll back the promotion because the
project itself is the more important artifact than the wow HTML, which
can be regenerated.

### 7.5 — A from-scratch project (no preview) opens the wizard
`preview_html` is NULL → the wizard's right-side pane doesn't render →
the wizard centers as it does today at `/ui-kit/onboarding`.

### 7.6 — A user starts the wizard, advances to step 2 (Connect), goes back to step 0, changes intent
The wizard's local state already supports this. The new
`onSaveIntent` fires again on Continue → and persists the new value.
Idempotent.

### 7.7 — Workspace banner copy when no preview exists
Step-count hint copy is the same regardless of preview presence. The
banner doesn't mention the preview — it talks about onboarding steps.

### 7.8 — Email confirmation flow timing
The promote happens in `/auth/callback` AFTER `exchangeCodeForSession`
succeeds, then redirects to `/projects/{id}/onboard`. No race — the
session is established before promote runs, RLS works as expected.

### 7.9 — User signs in on a different browser without the preview cookie
`promoteAnonymousPreviewIfPresent()` returns null → redirect falls
through to the `next` param (default `/dashboard`). They land on the
dashboard; if they had completed a preview from a different browser,
that preview eventually expires per the 24h TTL and is pruned.
Acceptable trade-off (already documented in `promote-preview.ts`).

### 7.10 — Resume after long inactivity
The project row persists indefinitely; the wizard resumes whenever the
user comes back. No timeout on partial onboarding.

---

## 8. Out of scope (deliberate)

- Real backing data for the workspace cards beyond what onboarding
  provides. Lighthouse scores, deploy history, AI iteration history,
  auto-sync metadata still come from `SITE_DETAIL_MOCKS` for `ready`
  projects. Replacing those is Phase 2's job.
- Migrating existing `draft`/`onboarding` projects in the database to
  set `intent`. Existing rows have `intent IS NULL`, so they'll appear
  as "Step 0 of 4" in the dashboard. A backfill is unnecessary because
  the only realistic existing rows are dev/test data.
- The "intent chip with edit affordance" on the workspace that
  [`docs/saas-mvp-transition.md`](../../saas-mvp-transition.md) §12
  mentions. `<IntentChip>` exists ([`intent-picker.tsx:163`](../../../apps/web/components/intent-picker.tsx#L163))
  but mounting it on the workspace is a separate UX iteration.
- Plugin auto-detection on connect (probing if the plugin is reachable
  before the user submits the connect form). Today the manual "Verify
  install" button on step 1 + the connect step's probe-on-submit cover
  the same ground.
- A "Skip ownership for now" affordance. Ownership defaults are
  reasonable (per-type recommendations) so a user can finish with the
  pre-selected values; there's no reason to allow them to skip.
- Per-row "Continue setup" CTA on the dashboard distinct from the row
  link. The whole row goes to the workspace; the workspace's banner is
  the resume affordance.
- Tests for the wizard. There aren't any in `apps/web` today (per the
  audit's SEC-1) and adding them here would be out of scope. The
  existing test discipline for new actions stays the bar — tenant-
  isolation tests would catch RLS slips in the new actions.
- **Real WP content-type enumeration** in the connect step. The
  manifest gives us ability names (e.g. `jab/get-posts`), not a
  per-post-type catalog with counts. For this spec we derive the
  ownership-step list from the manifest via a heuristic
  (`lib/jab/content-types-from-manifest.ts`) — parses the `jab/get-*` /
  `jab/list-*` ability names, dedupes, attaches reasonable defaults.
  Real counts and rich type metadata need either a new plugin endpoint
  or REST-side enumeration (`/wp/v2/types/{slug}` + X-WP-Total) —
  scoped as a follow-up.

---

## 9. Implementation order

Each step is independently verifiable; later steps depend on earlier ones.

1. **Migration** — `0011_project_onboarding_state.sql`. Verify by reading
   `\d projects` against a local Supabase and seeing the new columns.
2. **`promoteAnonymousPreviewIfPresent` extension** — copy
   `generated_html` → `preview_html` on the new project. Verify by
   running the `/preview` → signup flow and checking the projects row
   has non-null `preview_html`.
3. **New server actions** in `lib/actions/onboarding.ts` —
   `saveIntentAction`, `verifyPluginAction`, `completeOnboardingAction`.
   Delete `saveGithubAction` + `GithubInput`. Typecheck.
4. **`OnboardingWizard` props** — `initialStepIndex` + `onSaveIntent`.
   Update the demo at `/ui-kit/onboarding` to exercise the new prop.
   Typecheck + click-through the demo.
5. **`/projects/[id]/onboard` route rewrite** — replace contents.
   Delete `wp-creds-form.tsx` and `github-form.tsx`. Walk the wizard end
   to end against a real WP install (Two Roads Brewing).
6. **Redirect target changes** — three lines in
   `sign-in-form.tsx`, `auth/callback/route.ts`, `projects.ts`.
   Typecheck. Sign up via `/preview` → confirm landing on
   `/projects/{id}/onboard`.
7. **Workspace draft-aware updates** — banner + card empty states.
   Visit `/projects/{id}` for a draft project, confirm the banner
   renders and the cards have appropriate empty states.
8. **Dashboard step-aware badges** — query + badge logic.
9. **Self-verification pass** — typecheck, click through the four
   scenarios in §3, and run the smoke flow start-to-finish in dev.

---

## 10. Files touched

**New:**
- `apps/web/drizzle/migrations/0011_project_onboarding_state.sql`

**Modified:**
- `apps/web/lib/db/schema.ts` (mirror migration 0011 — intent, contentOwnership, previewHtml)
- `apps/web/lib/actions/promote-preview.ts` (copy preview_html)
- `apps/web/lib/actions/onboarding.ts` (new actions + remove GitHub bits)
- `apps/web/lib/actions/projects.ts` (redirect target)
- `apps/web/components/onboarding-wizard.tsx` (two new props)
- `apps/web/components/ui/onboarding-shell.tsx` (new `aside` prop)
- `apps/web/app/(auth)/sign-in/sign-in-form.tsx` (redirect target)
- `apps/web/app/auth/callback/route.ts` (redirect target)
- `apps/web/app/(app)/projects/[id]/onboard/page.tsx` (full rewrite)
- `apps/web/app/(app)/projects/[id]/page.tsx` (draft-aware additions)
- `apps/web/app/(app)/dashboard/page.tsx` (step-aware badges)
- `apps/web/app/ui-kit/onboarding/onboarding-demo.tsx` (mock onSaveIntent)

**Deleted:**
- `apps/web/app/(app)/projects/[id]/onboard/wp-creds-form.tsx`
- `apps/web/app/(app)/projects/[id]/onboard/github-form.tsx`
