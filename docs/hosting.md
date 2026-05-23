# Hosting decision — `apps/web` SaaS

> **Status:** Decided 2026-05-23 — **Vercel for the MVP**, Cloudflare as the planned
> scale target. This resolves open decision #1 in [`saas-mvp-transition.md`](saas-mvp-transition.md).
> For the Claude Code session building Phase 2: the actionable requirement is
> [§7 the provider seam](#7-engineering-requirement--the-provider-seam) — read it before
> writing the deploy step.

---

## 1. Two hosting needs (don't conflate them)

The platform has two distinct hosting concerns:

1. **The control plane** — `apps/web`, the Jab dashboard itself. One Next.js app,
   modest traffic. Cheap to host anywhere. Not a cost driver.
2. **The tenant fleet** — the generated client sites, one per project. This is
   N-and-growing, this is the COGS driver, and this is the decision that matters.

**Supabase is not a candidate for either.** Supabase is Postgres + Auth + Storage; its
Edge Functions are single-purpose Deno functions, not a Next.js runtime. It cannot
host a Next.js SSR/ISR app. Supabase stays as the **data layer** for the control plane
regardless of who hosts the frontends — it neither favors nor blocks this decision.
(`apps/web` is not currently "hosted on Supabase"; in dev it runs locally via
`next dev` and Supabase only holds its database.)

## 2. Decision

- **MVP:** host both the control plane and the tenant fleet on **Vercel**.
- **Scale target:** migrate the tenant fleet to **Cloudflare** — ideally Workers for
  Platforms — once the fleet and the bill justify the engineering investment
  ([§6 migration trigger](#6-migration-trigger)).
- The deploy pipeline must be built behind a **provider seam** ([§7](#7-engineering-requirement--the-provider-seam))
  so the migration is a contained, one-module change.

## 3. Why Vercel for the MVP

At the MVP/validation stage the binding constraint is engineering speed and product
risk — not infrastructure cost.

- Next.js is a Vercel product — zero adapter friction; ISR, image optimization, and
  middleware behave exactly as the generated code expects.
- **Preview deployments per generation are native and free.** Phases 2 and 4 of the
  transition plan depend on "a preview URL per generation" being the product's
  see-your-site moment and the spine of the AI iteration loop. Vercel provides
  immutable preview deployments + promote-to-prod out of the box. On Cloudflare that
  flow is something you build.
- Deploy-via-API is mature and well documented.
- At single digits to low dozens of sites the bill is a rounding error — speed to a
  validated product matters far more than COGS at this stage.

Vercel is the fastest path to a *validated product*. It is not the cheapest path to a
*large fleet*. Those are different phases.

## 4. Cost analysis

Modeling a fleet of **100 low-traffic SMB marketing sites** — ~10k pageviews/site/mo,
~1.5 GB bandwidth/site, ~200k requests/site (mostly static assets), ISR so HTML is
mostly cached. Structural estimates from current published pricing — treat the *shape*
as the signal, verify decimals against a live calculator before committing.

| Platform | Base/mo | Bandwidth model | ~Cost, 100 low-traffic sites | ~Per-site | Next.js fit |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare** Workers/Pages | $5 | Free egress; static requests free | ~$5–15/mo | ~$0.05–0.15 | Good via OpenNext / vinext — more setup |
| **Cloudflare** Workers for Platforms | $25 | Free egress | ~$25–50/mo | ~$0.25–0.50 | Same — purpose-built for multi-tenant |
| **Vercel** Pro | $20/seat (+$20 credit) | 1 TB incl., then $0.15/GB | ~$20–80/mo, variance-prone | ~$0.20–0.80 | Native — perfect |
| **Netlify** Pro | $20 | Credit-based, 20 credits/GB | ~$40–120/mo+ | ~$0.40–1.20 | Good (adapter) |

The structural story:

- **Cloudflare charges nothing for bandwidth or static-asset requests.** For a fleet
  of marketing sites (almost all cached static HTML + assets) that is a different cost
  *curve*, not a discount — the bill barely moves as the fleet grows.
- **Vercel's exposure is the trajectory and the variance, not this snapshot.** Cheap at
  100 low-traffic sites, but the bill is usage-metered across bandwidth, edge requests,
  function invocations, and per-source-image optimization, and Vercel is known for
  surprise bills on traffic spikes. There is also a structural ceiling:
  one-project-per-site hits Vercel project-count / deployment-retention limits well
  before you'd want it to.
- **Netlify** is the weakest fit — its 2026 credit model meters bandwidth at the
  priciest rate of the three and makes COGS hard to forecast.

Against the per-site subscription in the pricing plan, COGS on any of these is a small
fraction of revenue at MVP scale — which is exactly why cost does not drive the MVP
decision.

## 5. Why Cloudflare is the scale target

- **Bandwidth-free economics** keep COGS near-flat as the fleet grows; Vercel's grows
  with usage.
- **Workers for Platforms is purpose-built for this exact shape** — a platform hosting
  *its customers'* sites in isolated, sandboxed environments with per-tenant resource
  bindings. It is the clean answer to the project-count ceiling Vercel's model creates.
- **Next.js on Cloudflare has matured.** `@opennextjs/cloudflare` supports SSR, ISR,
  middleware, and the Image component "without major code changes" and runs production
  sites; Cloudflare also shipped `vinext` (a 2026 Vite-based Next.js reimplementation,
  ISR built in). It is still more setup and validation than Vercel-native — the
  generated output must be tested against the adapter — but it is no longer a research
  project.

## 6. Migration trigger

Move the tenant fleet to Cloudflare when **either**: the fleet reaches roughly
**50–100 sites**, **or** Vercel's monthly bill / bill variance / project-count limits
start showing up in practice. By then there is revenue funding the engineering, and
the COGS delta (cents/site vs. up to ~$1/site, plus eliminated bill variance) is real
margin protection. The control plane can stay on Vercel indefinitely — it is one app.

## 7. Engineering requirement — the provider seam

**This is the part Phase 2 must implement.** The transition plan already puts
deployment behind a single worker step ("assemble file set → deploy via provider
API"). Build that step against a **provider-agnostic interface**, not Vercel calls
inlined into the worker:

```ts
// lib/deploy/provider.ts  (illustrative)
export interface DeployProvider {
  createPreview(input: { projectId: string; files: Map<string, string>; env: Record<string,string> }): Promise<{ deploymentId: string; previewUrl: string }>;
  promoteToProduction(input: { projectId: string; deploymentId: string }): Promise<{ productionUrl: string }>;
}
```

- Ship a `VercelProvider` implementation now.
- Keep all Vercel-specific concepts (project IDs, deployment API shapes, env-var API)
  *inside* that module. The worker, the job model, and the UI deal only in
  `deploymentId` / `previewUrl` / `productionUrl`.
- Do **not** over-abstract — one interface, one implementation, no plugin framework.
  The goal is simply that adding a `CloudflareProvider` later is a new file, not a
  rewrite. Because the generated output is standard Next.js, the swap stays contained.

Related: since the worker already assembles the file set itself, consider running
`next build` **inside the Inngest worker** and deploying the prebuilt artifact. That
sidesteps the host's build-minute metering and makes the provider seam even cleaner
(the provider just uploads + serves; it never builds).

## 8. Open follow-ups

- Custom-domain flow (MVP ships `client.jab.app` subdomains; custom domains come via
  the host's domain API — Vercel supports this natively).
- Where the control plane's own production deploy lives (recommend Vercel — trivial).
- Whether to consolidate the data layer onto Cloudflare (D1/Hyperdrive) if the fleet
  migrates — a separate, much later decision; Supabase's RLS + Auth are doing real
  work today and should not be touched for the MVP.

---

*Sources: Vercel, Cloudflare Workers / Workers for Platforms, and Netlify published
pricing pages; OpenNext Cloudflare adapter docs. Pricing checked May 2026 — re-verify
before financial commitments.*
