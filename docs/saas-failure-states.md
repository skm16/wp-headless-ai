# SaaS failure-state catalog

> Phase 1 design artifact for `apps/web`. Every failure surface gets a
> canonical title, body, recovery action, and tone, so the user never sees
> a raw exception string and the team never has to redesign the wording for
> each path. Engineering wires the trigger → catalog ID; the Alert primitive
> renders the copy.
>
> Source plan: [`docs/saas-mvp-transition.md`](saas-mvp-transition.md) §4
> Phase 1. Companion to [`you-are-a-senior-wobbly-hare.md`](../../../../Users/srskm/.claude/plans/you-are-a-senior-wobbly-hare.md) §4 Phase 1.

---

## How to use this catalog

1. **Engineering** — when a code path detects a failure, look up the matching
   ID below. Surface an `<Alert tone={tone} title={title} action={…}>` with
   the catalog copy. Do **not** pass raw exception strings to the UI.
2. **Design** — when reviewing screens, every Alert must trace to a catalog
   entry. New failures get a new row here before they ship.
3. **QA** — manually trigger each path (see §"Verification") and confirm the
   right copy appears.
4. **Telemetry** — each failure gets a stable tag (last column). Server-side
   logging includes the tag so we can count occurrences and identify which
   paths need product fixes vs. UX clarification.

## Copy principles

- **Recovery first.** Lead with what the user can do, not what went wrong.
- **No blame.** "We couldn't…" not "You didn't…".
- **No jargon.** No stack traces, no `stop_reason`, no `projectId`, no
  HTTP status codes in user-visible text.
- **Specific numbers and names.** Include the plan name, the count, the
  domain — anything that converts an abstract failure into a concrete one.
- **Security failures stay vague to the user.** Log specifics server-side.

---

## 1. Generation failures

These surface on the project workspace, attached to the failed generation
job row.

### QUAL-1 · Generated code didn't compile

| Field | Value |
| --- | --- |
| Severity | High |
| Trigger | The post-generation `next build` (or `tsc --noEmit`) step fails on the generated file set. |
| Tone | `danger` |
| Title | **We couldn't finalize this generation** |
| Body | The AI produced code that didn't quite build. This usually clears on a retry. |
| Action | `Regenerate` — re-runs the generation against the same page path. |
| Surfaces in | Project workspace, failed-job row + DeploymentsPanel `Latest deployment` slot. |
| Telemetry tag | `generation.fail.build` |
| Engineering note | Persist the build-error log internally for the operator — never to the UI. |

### QUAL-2 · Generation cut short

| Field | Value |
| --- | --- |
| Severity | High |
| Trigger | `stopReason !== "end_turn"` from `lib/ai/agent.ts` — typically `max_tokens`. |
| Tone | `warning` |
| Title | **The generation ran long and was cut short** |
| Body | Retrying gives it more room. If this keeps happening on a complex page, tell us — we may need to split the template. |
| Action | `Retry with more room` — re-runs with the same prompt and an increased token ceiling (engineering ticket: pass a higher `max_tokens` on retries flagged as QUAL-2). |
| Surfaces in | Project workspace, failed-job row. |
| Telemetry tag | `generation.fail.truncated` |

### COST-1 · Out of generations

| Field | Value |
| --- | --- |
| Severity | High |
| Trigger | Per-tenant generation quota exceeded; checked in `app/api/projects/[id]/generate/route.ts` before the Inngest event is sent. |
| Tone | `warning` |
| Title | **You're out of generations for this period on the {planName} plan** |
| Body | Upgrade to keep generating. Your published sites stay live. |
| Action | `Upgrade →` — links to `/billing`. |
| Surfaces in | Generate button tooltip (disabled state) + workspace header `QuotaMeter` upgrade link. The button itself never proceeds when at quota — failure shows only if the user reaches the route directly. |
| Telemetry tag | `generation.fail.quota` |
| Copy variant | When quota = 0 (trial expired): "Your trial has ended. Upgrade to generate new pages — your live site keeps running." |

### SEC-2 · Generation blocked

| Field | Value |
| --- | --- |
| Severity | Medium |
| Trigger | Worker's `load-context` step detects a mismatch between the Inngest event's `projectId` and the `generation_jobs.project_id` for the `jobId`. |
| Tone | `danger` |
| Title | **This generation was blocked** |
| Body | Something didn't line up on our end. Contact support if this keeps happening. |
| Action | `Contact support` — opens a `mailto:` or support form. |
| Surfaces in | Failed-job row. |
| Telemetry tag | `generation.fail.security.id_mismatch` |
| Engineering note | Intentionally vague to the user. The detailed mismatch is logged server-side (project IDs, tenant IDs). Never surface internal IDs. |

### REL-1 · Retrying (informational, not a failure)

| Field | Value |
| --- | --- |
| Severity | Low (informational) |
| Trigger | Inngest auto-retried the function (`retries: > 0`). Shown only if retry count ≥ 1 and the eventual outcome is still pending or succeeded. |
| Tone | `info` |
| Title | (no title) |
| Body | Retrying… (attempt {n} of {max}). |
| Action | None. |
| Surfaces in | Running-job row, inline next to the status badge. Renders as a small text caption, not a full Alert. |
| Telemetry tag | `generation.retry` |
| Engineering note | If retries exhaust and the final outcome is `failed`, surface the underlying QUAL-1/QUAL-2 instead — don't surface REL-1 standalone in a terminal failure state. |

---

## 2. Connection failures

These surface on the WordPress probe (onboarding) and on the Connections
page when stored credentials stop working.

### WP-1 · WordPress URL must be HTTPS

| Field | Value |
| --- | --- |
| Severity | Medium |
| Trigger | The submitted `wp_url` parses as `http://`. Rejected before the probe runs. |
| Tone | `danger` |
| Title | (no title) |
| Body | We need your WordPress site to use HTTPS. Most hosts include a free SSL certificate — talk to your host or check the site's settings. |
| Action | None — the form field error guides the user back. |
| Surfaces in | Onboarding `Field` error slot directly under the URL input. Not as a full Alert — the inline error is enough. |
| Telemetry tag | `probe.fail.http` |
| Engineering note | Also tightens the SSRF surface (see SEC-3). Enforce server-side too — don't trust client-side validation alone. |

### WP-2 · Couldn't connect to that WordPress site

| Field | Value |
| --- | --- |
| Severity | Medium |
| Trigger | The probe HTTP request times out, returns a network error, or hits a non-WordPress response. |
| Tone | `danger` |
| Title | **We couldn't reach that WordPress site** |
| Body | Check that the URL is right and that the site is up. If the site is behind a maintenance plugin, disable it temporarily and try again. |
| Action | None — user retries from the form. |
| Surfaces in | Onboarding form Alert above the submit button. |
| Telemetry tag | `probe.fail.unreachable` |

### WP-3 · Sign-in didn't work

| Field | Value |
| --- | --- |
| Severity | Medium |
| Trigger | Probe reached the site but got `401`/`403` on `/wp-json/jab/v1/manifest`. |
| Tone | `danger` |
| Title | **Those credentials didn't work** |
| Body | Double-check the username and application password. Application passwords (Users → Profile → Application Passwords in WordPress) work more reliably than regular login passwords. |
| Action | None — user retries from the form. |
| Surfaces in | Onboarding form Alert above the submit button. |
| Telemetry tag | `probe.fail.auth` |

### WP-4 · Jab plugin not installed

| Field | Value |
| --- | --- |
| Severity | Medium |
| Trigger | Probe reached the site but the `/wp-json/jab/v1/manifest` route 404s. |
| Tone | `warning` |
| Title | **The Jab plugin isn't installed on this site** |
| Body | Install and activate the Jab plugin in WordPress, then try again. Need the plugin file? We'll email it — contact support. |
| Action | `Contact support` |
| Surfaces in | Onboarding form Alert above the submit button. |
| Telemetry tag | `probe.fail.plugin_missing` |

### WP-5 · WordPress connection needs refreshing

| Field | Value |
| --- | --- |
| Severity | Medium |
| Trigger | A *post-onboard* request to WordPress (during a generation) fails with `401`/`403` — the agency rotated the password or revoked the app password. |
| Tone | `warning` |
| Title | **Your WordPress connection needs to be refreshed** |
| Body | Your client's WordPress credentials stopped working. Reconnect and we'll resume generating. Your live site keeps running. |
| Action | `Reconnect →` — links to the project's `Connections` page. |
| Surfaces in | Project workspace banner + failed-job row when triggered mid-generation. |
| Telemetry tag | `connection.expired.wp` |
| Engineering note | This is the failure mode that makes a `Refresh credentials` button (Phase 2 deliverable 2E) load-bearing. Today a stale credential surfaces only as an opaque generation failure.|

---

## 3. Deployment failures (Phase 2)

These surface once the hosting layer ships. Specified here so the catalog
is complete from day one of Phase 2.

### DEP-1 · Deployment didn't go live

| Field | Value |
| --- | --- |
| Severity | High |
| Trigger | The hosting provider API call (`vercel deploy`) returns a non-`READY` final state. |
| Tone | `danger` |
| Title | **Your preview didn't go live** |
| Body | We hit a snag publishing this version. Try again — if it sticks, contact support. |
| Action | `Retry deploy` |
| Surfaces in | Deployments panel, deployment row. |
| Telemetry tag | `deploy.fail.provider` |

### DEP-2 · Custom domain DNS not resolving

| Field | Value |
| --- | --- |
| Severity | Medium |
| Trigger | The custom-domain verification check on the Connections page can't resolve the CNAME / A-record after N retries. |
| Tone | `warning` |
| Title | **DNS isn't pointed at us yet** |
| Body | Add a CNAME for `{customer-domain}` → `{jab-target}` at your DNS provider. Changes can take up to 24 hours. We'll keep checking. |
| Action | `Show DNS instructions` (opens a side-panel with the exact records). |
| Surfaces in | Connections page → Hosting → Custom domain row. |
| Telemetry tag | `domain.fail.dns` |

---

## 4. Plan / billing failures (Phase 5)

### BILL-1 · Card was declined

| Field | Value |
| --- | --- |
| Severity | Medium |
| Trigger | Stripe checkout / subscription charge returns `card_declined`. |
| Tone | `danger` |
| Title | **Your card was declined** |
| Body | Try another card or contact your bank. Your sites keep running for now — we'll keep trying for a few days. |
| Action | `Update payment method →` (Stripe billing portal). |
| Surfaces in | Billing page banner. |
| Telemetry tag | `billing.fail.card` |

### BILL-2 · Trial ended

| Field | Value |
| --- | --- |
| Severity | Medium (UX-soft) |
| Trigger | Trial period for the tenant has elapsed (soft pause per §10 #4 of the design plan — site stays live, generation surfaces disable). |
| Tone | `warning` |
| Title | **Your trial has ended** |
| Body | Your site is still live at `{productionUrl}`. Upgrade to keep generating and refining pages. |
| Action | `Upgrade →` — links to `/billing`. |
| Surfaces in | Project workspace, full-width banner above the deployment panel. |
| Telemetry tag | `billing.trial.expired` |

---

## 5. Style guide for new entries

When adding a failure, write it like the existing entries:

- **Title** is the Alert headline. Max ~6 words. Capitalize first word only.
- **Body** is 1–2 sentences. Lead with what the user does next.
- **Action** is the recovery affordance — button label + what it triggers.
- **Tone** is one of `info` / `warning` / `danger`. Map by severity:
  - `danger` → blocked the user from a goal they were trying to achieve.
  - `warning` → user can continue, but something needs attention.
  - `info` → notification only, no blocker.
- **Telemetry tag** is `{surface}.{result}.{detail}` — dot-separated, lower-snake. Stable across renames.

---

## 6. Verification

Each path should be reproducible end-to-end before Phase 2 hosting ships:

| ID | How to reproduce |
| --- | --- |
| QUAL-1 | Force the build step to fail (inject a `throw` after the generate step in dev). |
| QUAL-2 | Manually mock `stopReason: "max_tokens"` in `lib/ai/agent.ts` return. |
| COST-1 | Set the tenant's quota to a low value, run two generations. |
| SEC-2 | Send a crafted Inngest event with mismatched `projectId`. |
| REL-1 | Set `retries: 2` and force the first attempt to throw. |
| WP-1 | Submit `http://example.com` in the onboarding URL field. |
| WP-2 | Submit a known-down URL (or block DNS for the dev box). |
| WP-3 | Submit valid URL with wrong password. |
| WP-4 | Submit a WordPress site that doesn't have the Jab plugin installed. |
| WP-5 | After successful onboarding, rotate the app password in WP admin and trigger a generation. |
| DEP-1 | Mock the Vercel API to return a failed deployment state. |
| DEP-2 | Add a custom domain with a CNAME that doesn't resolve. |
| BILL-1 | Use Stripe's `tok_chargeDeclined` test card. |
| BILL-2 | Manually advance the tenant's `trial_ended_at` to a past date. |

Each verified path becomes a row in a smoke-test sheet maintained alongside
this catalog.
