# Vercel Platform Setup — JAB SaaS v2 Phase D Prerequisites

> **One-time operator runbook.** Required before the first Phase D build can
> deploy. Sets up the Vercel team, token, and env vars the deploy-site
> worker needs.

## Outcome

After this runbook, the following two env vars are populated in:
- `apps/web/.env.local` (local dev)
- The production worker host's env (Inngest cloud / Vercel cloud / wherever the JAB platform itself runs)

Variables:
- `VERCEL_TOKEN` — an access token with scope `Full Account` on the JAB Platform team
- `VERCEL_TEAM_ID` — the team's stable identifier (looks like `team_xxx`)

## Steps

### 1. Create or confirm the JAB Platform Vercel team

If you already have a Vercel team you'll use for customer site deployments, skip to step 2.

1. Sign in to [vercel.com](https://vercel.com).
2. Top-left team picker → **Create a Team**.
3. Name: `JAB Platform` (or whatever brand name you've landed on).
4. Pricing: the Hobby tier is fine for early customers; bump to Pro when build minutes are the constraint.
5. Save.

### 2. Capture the team ID

1. With the JAB Platform team active, go to **Settings** (left sidebar).
2. Under **General**, look for **Team ID**. It's a string like `team_xxxxxxxxxxxxxxxxxxxxxxxx`.
3. Copy it.

### 3. Generate a service token

1. From any team's context, click the avatar (top-right) → **Account Settings** → **Tokens**.
2. **Create Token**.
3. Name: `jab-platform-worker` (or include the date/host for traceability).
4. Scope: **Full Account** — necessary for `POST /v11/projects` and env-var ops.
5. Expiration: **No expiration** for v1; you can rotate manually later.
6. **Create**. Copy the token IMMEDIATELY — Vercel will not show it again.

### 4. Populate env vars

In `apps/web/.env.local`, add:

```
VERCEL_TOKEN=<paste the token>
VERCEL_TEAM_ID=team_xxxxxxxxxxxxxxxxxxxxxxxx
```

For the production worker host, set the same two env vars via that platform's secret-management UI.

### 5. Verify the token works

From `apps/web/`:

```
pnpm tsx -e "console.log(process.env.VERCEL_TEAM_ID)"
```

Expected: prints the team ID, confirming `.env.local` is loaded.

Then make one cheap API call to verify the token:

```
pnpm tsx -e "fetch('https://api.vercel.com/v10/projects?teamId=' + process.env.VERCEL_TEAM_ID, { headers: { Authorization: 'Bearer ' + process.env.VERCEL_TOKEN } }).then(r => r.json()).then(r => console.log(r.projects?.length ?? 0, 'projects')).catch(console.error)"
```

Expected: prints something like `0 projects` (or however many you have). Anything else (401, 403, malformed JSON) means the token or team ID is wrong.

## What happens if the token is missing at deploy time

The `deploy-site` worker throws `VERCEL_TOKEN not set. See docs/superpowers/operator/2026-05-28-vercel-platform-setup.md` on its first step. The Inngest dev UI surfaces this as the function error; the build sits at `status='building'` (no progress) until the env vars are restored. No partial work is committed — re-running the trigger picks up cleanly.

## Cost model

The free Hobby tier covers small numbers of customer site builds. Roughly:
- Each build: ~$0.40 in Vercel build minutes when on the Pro tier
- Storage egress: negligible for our project size (~150KB tree per build)

Move to Pro when (a) you cross the Hobby build-minute cap, or (b) you need preview environments per build (Phase F polish).

## Rotation

To rotate the token:
1. Repeat step 3 with a new token name.
2. Update `VERCEL_TOKEN` in both `.env.local` and production env.
3. Delete the old token in Vercel's UI.
4. No worker downtime required; the next Phase D run picks up the new token.
