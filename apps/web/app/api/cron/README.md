# /api/cron/* — self-authentication REQUIRED

This entire prefix is exempt from the session middleware (`apps/web/middleware.ts`
PUBLIC_ROUTES) because Vercel Cron carries no session cookie. **Every route in
this directory MUST therefore self-authenticate** — follow `prune/route.ts`:
fail closed with 503 when `CRON_SECRET` is unset, 401 unless
`Authorization: Bearer <CRON_SECRET>` matches, before doing any work.
