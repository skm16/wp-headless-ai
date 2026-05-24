# Concierge operator runbook

> Phase 0 motion. The operator (Sean, then maybe one teammate) runs the
> generation flow manually for an early agency, deploys the output to a
> Jab-owned Vercel account, and hands back a live URL. No self-serve, no
> hosting layer in the SaaS yet — that's what Phase 2 builds.

The goal of this runbook is to make the loop **repeatable** so the operator
can run it confidently at 11pm before a client demo. Each engagement should
take 1–2 hours, dropping to ~30 minutes once the operator is fluent.

---

## When to use this

- An agency has agreed to pay the setup fee + small monthly for a
  concierge-deployed site.
- You have **not** yet built the Phase 2 hosting layer (see
  `docs/saas-mvp-transition.md`). Once Phase 2 ships, the manual deploy steps
  in §4 go away.

## Stop criteria

Move off concierge once any of:

- Five paid agencies running through this loop in a single month — the
  manual cost is exceeding the learning value.
- The agency-feedback themes have stabilized (no new objections in the last
  three engagements) — you've heard the real bar and you know what Phase 2
  has to clear.

---

## 1. Prereqs

Before the operator starts a new engagement:

- [ ] **Agency confirms commercial terms.** Setup fee + monthly. Capture
      in a sales-tracking sheet; this is the willingness-to-pay signal the
      phase exists to measure.
- [ ] **Agency provides WordPress access:**
  - WordPress site URL (must be HTTPS — see §5 gotchas)
  - WordPress username with admin rights
  - Application password generated from WP Users → Application Passwords
- [ ] **Operator has access to:**
  - Jab production deployment of the SaaS (to run the generation flow)
  - Jab-owned Vercel team account (where the deployed site lives)
  - DNS access on `jabwp.app` (to point a subdomain at the new deployment)

## 2. Create the project in Jab

1. Sign in to the Jab app as the operator account.
2. Click **New project**. Name it `{agency-slug}-{client-slug}` — e.g.
   `label-interactive-acme-coffee`. This is what shows up in the operator's
   project list, not the client.
3. Walk the onboarding wizard (auto-opens after the project is created):
   - **Intent:** pick **Faithful** for migration engagements (default), or
     Refresh / Reimagine if the client wants a real redesign.
   - **Install plugin:** confirm the Jab plugin is active on the client WP
     (Composer-install + activate, or upload the .zip via wp-admin). Click
     **Verify install** to confirm `/wp-json/jab/v1/` is reachable.
   - **Connect:** submit the agency-provided WP username + application
     password. On success the probe pulls the manifest and the wizard advances.
   - **Ownership:** review the content-type list, accept the recommended
     defaults (pages → Jab-managed, collections → WP-managed) unless the
     agency requested otherwise. Click **Finish setup**.
4. Back on the workspace, note the count and content types listed in the
   WordPress Connection card — useful for the engagement log + the feedback
   summary.

## 3. Generate the homepage

1. From the project detail page click **Generate homepage**.
2. Wait for the job to complete (60–120s — this is the opaque "Generating…"
   wait that Phase 2 fixes).
3. Verify the job status flips to `succeeded`. If it shows `failed`, capture
   the error verbatim — these are the failures Phase 1's catalog is built
   from.
4. Note the model + token usage on the job row. Adds to the per-engagement
   COGS log.

## 4. Manual deploy (the part Phase 2 replaces)

> **⚠ BLOCKED as of 2026-05-24.** The GitHub credential step in the onboarding
> wizard was removed in commit `ea1dc2f` (the SaaS-transition-doc §5 Phase 2
> "Demote GitHub" item, pulled forward ahead of the direct-deploy pipeline).
> Steps 1–2 below are no longer reachable through the wizard UI. Until Phase 2's
> Vercel-API direct-deploy lands, new concierge engagements must either:
>
> - **Pause:** defer new concierge engagements until Phase 2's deploy pipeline
>   ships (recommended — the wow-preview funnel + dashboard are enough to show
>   prospects the product).
> - **Sideload creds via SQL:** the `github_repo_full_name` and
>   `github_pat_encrypted` columns still exist on `projects`; an operator with
>   service-role access can encrypt a PAT via `lib/crypto/encrypt.ts`'s
>   `encryptToBytea` and UPDATE the row directly. Then steps 3–7 below still
>   work against the existing `lib/github/push.ts`. This is a manual,
>   audit-trail-light workaround — only acceptable for paid concierge work
>   with an explicit operator log.
>
> The original steps remain below for reference and for the recovery path
> when Phase 2 lands a replacement.

Today this still pushes generated code to a GitHub branch on the agency's
repo. For concierge engagements we override that by:

1. Use the operator-owned scratch GitHub repo (one per engagement —
   `jab-concierge-{agency-slug}-{client-slug}`).
2. ~~Provide that repo's owner+name and a fine-grained PAT as the GitHub
   credentials during onboarding.~~ **Not reachable via wizard as of
   2026-05-24** — see the BLOCKED note above for the SQL sideload workaround.
3. After generation, locally:
   ```powershell
   git clone https://github.com/{owner}/{repo}
   cd {repo}
   git checkout {generated-branch-name}
   pnpm install
   ```
4. Create `.env.local` with the agency's WP credentials (encrypt-at-rest in
   the operator's password manager — these are production secrets):
   ```env
   WP_URL=https://{client-wp-site}.com
   WP_USER={username}
   WP_APP_PASSWORD={app-password}
   ```
5. Verify locally with `pnpm dev` → http://localhost:3000. Spot-check the
   homepage renders with the client's content.
6. Push the branch to Vercel via the Vercel CLI:
   ```powershell
   vercel link --project={engagement-slug}
   vercel env add WP_URL production
   vercel env add WP_USER production
   vercel env add WP_APP_PASSWORD production
   vercel deploy --prod
   ```
7. Note the production Vercel URL.

## 5. Connect the URL

1. In the Jab DNS provider, create a CNAME for
   `{client-slug}.jabwp.app` pointing at the Vercel production URL.
2. In Vercel, add `{client-slug}.jabwp.app` as a production domain on the
   project. Vercel issues a cert automatically.
3. Verify in incognito: visit `https://{client-slug}.jabwp.app/` and confirm
   the site loads end-to-end.

## 6. Handoff

Send the agency a hand-off email that includes:

- The live URL: `https://{client-slug}.jabwp.app/`
- A note that this URL is provisional — once they're ready, we can attach
  their client's real domain (one-time DNS change on the client's side).
- An invitation to send feedback in plain English: "what's wrong? what would
  the client want different?" That feedback becomes the input to the next
  iteration.
- A reminder that when the client edits WordPress, the deployed site
  refreshes within ~60 seconds (ISR revalidate window) — no republish
  required.

## 7. Iteration

When the agency sends feedback:

1. Generate again from the Jab UI (same project, will push to a new branch).
2. Locally checkout the new branch, redeploy to Vercel preview, share the
   preview URL with the agency.
3. Once approved, run `vercel promote {preview-url} --scope={team}` to flip
   the production URL.

This loop is what Phase 4 (AI iteration) automates inside the SaaS.

---

## Gotchas

- **WP must be HTTPS.** The probe rejects `http://` URLs (per the §10 #2
  decision in the transition plan). If the agency's client site is on HTTP,
  resolve that first — most hosts include a free SSL cert. Do not skip; the
  iframe preview surface in Phase 2 will silently break and the SSRF surface
  is wider than necessary.
- **App passwords vs. user passwords.** Agencies will sometimes send the
  admin's regular login password. The probe will accept either if the user
  has admin rights, but app passwords are revocable per-integration and
  required for the manifest endpoint to work reliably. Insist on an app
  password.
- **WP content types with custom REST args.** If the client uses
  Advanced Custom Fields or a plugin that re-shapes the REST response, the
  generation may produce code referencing fields that don't render the way
  the AI expected. Capture these as feedback themes — they shape the prompt
  changes in Phase 3.
- **Token budgets.** A homepage generation can run `~$0.30–$1.50` on Opus
  depending on the page complexity. Log it per engagement so we have real
  COGS data before the Phase 5 pricing decisions.

---

## Per-engagement log template

Maintain a single sheet with one row per engagement:

| Field | Notes |
| --- | --- |
| Agency name | |
| Client name | |
| Date connected | |
| WP site URL | |
| Content types found | (count + a few examples) |
| Generation duration | seconds |
| Token cost | input + output, in $ |
| Failures observed | (verbatim error strings → input to Phase 1 catalog) |
| Iterations until handoff | |
| Agency feedback themes | (free text — the gold) |
| Setup fee / monthly | |

---

## What this runbook explicitly is NOT

- It is **not** a process that should scale beyond ~5 active engagements at
  a time. If it starts to scale, that's a signal to ship Phase 2 hosting and
  retire this document.
- It is **not** the agency-facing workflow. Don't share this with agencies —
  they should see the Jab UI plus the live URL, full stop.
