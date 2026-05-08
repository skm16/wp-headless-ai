# Phase B — `apps/web/` Shell (Auth, Projects, Multi-tenancy)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the multi-tenant SaaS skeleton — a user can sign up, an automatic tenant is provisioned for them, they can create projects (name + client name + WP URL), and a second tenant cannot see the first tenant's projects (RLS-enforced at the database).

**Architecture:** Add `apps/web/` (Next.js 15 App Router) to the existing monorepo. Auth + Postgres + RLS via Supabase. Drizzle ORM for typed queries. Multi-tenancy enforced at the database layer with Row-Level Security policies that key on `auth.uid()` against a `tenant_members` junction table. Phase B intentionally ships **no AI, no GitHub, no Inngest** — just the SaaS shell. Phases C–F bolt onto this foundation.

**Tech Stack:** Next.js 15 App Router · TypeScript · Tailwind CSS · Supabase (auth + Postgres + RLS) · Drizzle ORM · `@supabase/ssr` for cookie-aware server client · `postgres` driver · `zod` for input validation.

---

## Why this exists

Phase A extracted [`packages/core`](../../../packages/core/) so the engine is callable from a server context. Phase B builds the SaaS shell where that engine will live. Doing it BEFORE Phase C (onboarding wizard) and Phase D (AI worker) means the multi-tenant boundary, auth flow, and credential storage are nailed down before any production data touches the system. Every subsequent phase relies on this foundation; getting it wrong here is expensive to retrofit.

## Acceptance criteria

1. A new user signs up at `/sign-in`, gets redirected to `/dashboard`, sees an empty projects list with a "Create project" CTA.
2. A default tenant is auto-created on first sign-up. The user is its `owner`.
3. The user creates a project via `/projects/new` with name + client name + WP URL. Project appears in their dashboard list.
4. Clicking the project opens `/projects/[id]` showing the metadata + a placeholder "Onboarding wizard (Phase C)" section.
5. **Cross-tenant isolation test passes**: a second user signed up in a different tenant cannot see (or read by ID, or update, or delete) the first tenant's projects. Verified both via UI navigation AND a direct SQL query as the second user's role.
6. `pnpm --filter @jab/web build` succeeds (production-ready Next.js build, no type errors).

---

## File structure (additions only)

```
apps/web/
├── package.json
├── tsconfig.json
├── next.config.ts
├── postcss.config.mjs
├── tailwind.config.ts
├── .env.local.example                    + (committed; .env.local gitignored)
├── drizzle.config.ts                     + drizzle-kit config
├── middleware.ts                         + auth-guards (app)/* routes
├── app/
│   ├── layout.tsx                        + root layout
│   ├── page.tsx                          + marketing landing
│   ├── globals.css                       + Tailwind directives
│   ├── (auth)/
│   │   ├── layout.tsx                    + auth-pages shell (centered, marketing)
│   │   └── sign-in/page.tsx              + email + password sign-in/sign-up
│   └── (app)/
│       ├── layout.tsx                    + sidebar + header chrome
│       ├── dashboard/page.tsx            + projects list (Server Component)
│       └── projects/
│           ├── new/page.tsx              + create-project form
│           └── [id]/page.tsx             + project detail
├── lib/
│   ├── supabase/
│   │   ├── client.ts                     + browser client
│   │   ├── server.ts                     + RLS-aware server client (cookies)
│   │   └── admin.ts                      + service-role client (bypasses RLS for system operations)
│   ├── db/
│   │   ├── schema.ts                     + Drizzle table definitions
│   │   └── client.ts                     + Drizzle instance bound to a Supabase-issued connection
│   └── actions/
│       └── projects.ts                   + server actions (create, list — wraps Drizzle calls)
└── drizzle/
    └── migrations/
        ├── 0000_initial_schema.sql       + tables + indexes
        └── 0001_rls_policies.sql         + Row-Level Security setup
```

---

## Pre-flight (USER-OWNED, manual)

Before tasks 1–13 can run, the user must do two things:

1. **Create a Supabase project.** [supabase.com → New Project](https://supabase.com). Pick a region (US-East is default; match wherever the bulk of agency clients will be). Set a strong database password — save it to a password manager.
2. **Capture three secrets** from Supabase project Settings → API:
   - Project URL (public, e.g. `https://abcdef.supabase.co`)
   - `anon` public key (safe in browser bundles)
   - `service_role` secret key (NEVER ship to browser; treat like a root password)

These get pasted into `apps/web/.env.local` after Task 1 completes.

---

## Task 1 — Monorepo wiring + Next.js scaffold

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/tailwind.config.ts`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/globals.css`
- Modify: `pnpm-workspace.yaml`

- [ ] **Step 1: Add `apps/*` to the workspace**

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 2: Create `apps/web/package.json`**

```json
{
  "name": "@jab/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@jab/core": "workspace:*",
    "@supabase/ssr": "^0.5.2",
    "@supabase/supabase-js": "^2.45.0",
    "drizzle-orm": "^0.36.0",
    "next": "^15.0.0",
    "postgres": "^3.4.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "autoprefixer": "^10.4.20",
    "drizzle-kit": "^0.28.0",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.10",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 3: Create `apps/web/tsconfig.json` (Next.js standard with `@/*` path alias)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create the rest of the Next.js skeleton** (tailwind.config.ts, postcss.config.mjs, next.config.ts, app/layout.tsx, app/page.tsx with a placeholder marketing page, app/globals.css with Tailwind directives). Standard create-next-app output, just done by hand because we're embedding into an existing monorepo.

- [ ] **Step 5: Install + verify**

Run: `pnpm install`
Then: `pnpm --filter @jab/web dev`
Expected: dev server boots on port 3000, marketing landing renders.

- [ ] **Step 6: Commit**

```bash
git add apps/web/ pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(web): scaffold apps/web Next.js 15 + Tailwind shell"
```

---

## Task 2 — Supabase env wiring

**Files:**
- Create: `apps/web/.env.local.example`
- Modify: `apps/web/.gitignore` (or root) to ensure `.env.local` is ignored (Next.js gitignores it by default; verify)

- [ ] **Step 1: Document required env vars in `.env.local.example`**

```sh
# Supabase project URL — public.
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co

# Supabase anon key — public, safe in browser bundles. Provides RLS-respecting
# access for end-user sessions.
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...

# Supabase service-role key — SECRET. Bypasses RLS. Used only by server-side
# system operations (e.g. tenant provisioning trigger backfill). NEVER ship
# to the browser; never log; never include in error messages.
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# Direct Postgres connection string — used by Drizzle migrations + queries.
# Get from Supabase Project Settings → Database → Connection string → URI mode.
# Use the "Transaction" pooler endpoint (port 6543) for serverless / lambda
# scenarios; "Session" pooler (port 5432) for long-lived connections.
DATABASE_URL=postgres://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

- [ ] **Step 2: User pastes real values into `.env.local`** (not committed)

Verify: `node -e "console.log(process.env.NEXT_PUBLIC_SUPABASE_URL)"` from `apps/web/` after `dotenv` loads — sanity-check.

---

## Task 3 — Drizzle schema + initial migration

**Files:**
- Create: `apps/web/drizzle.config.ts`, `apps/web/lib/db/schema.ts`, `apps/web/lib/db/client.ts`, `apps/web/drizzle/migrations/0000_initial_schema.sql` (generated)

- [ ] **Step 1: `apps/web/drizzle.config.ts`**

```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  // Restrict introspection to the public schema; Supabase's auth schema is
  // managed separately and we should never write to it.
  schemaFilter: ["public"],
  strict: true,
  verbose: true,
});
```

- [ ] **Step 2: `apps/web/lib/db/schema.ts` — table definitions**

Key constraints:
- `profiles.id` references `auth.users(id)` (Supabase-managed). Using `uuid` + manual reference; Drizzle won't introspect Supabase's auth schema, so we treat this as a plain UUID FK in code.
- `tenants.id` is generated server-side via `gen_random_uuid()`.
- `projects.tenant_id` is NOT NULL — every project belongs to exactly one tenant.
- `projects.status` is a Postgres enum-as-text constraint: `'draft' | 'onboarding' | 'ready' | 'archived'`. Phase B uses `'draft'` and `'onboarding'`; later phases add the rest.

```ts
import { pgTable, uuid, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

// Mirrors the user-controllable subset of auth.users. Created by a database
// trigger on auth.users insert (see migration 0001). We never insert into
// this table from app code — Supabase auth owns the lifecycle.
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),  // FK to auth.users(id), enforced in migration SQL
  email: text("email"),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tenantMembers = pgTable(
  "tenant_members",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),  // FK to auth.users; enforced in migration SQL
    role: text("role").notNull().default("owner"),  // 'owner' | 'admin' | 'member'
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.userId] }) }),
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    clientName: text("client_name"),
    wpUrl: text("wp_url"),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ tenantIdx: index("projects_tenant_id_idx").on(t.tenantId) }),
);
```

- [ ] **Step 3: `apps/web/lib/db/client.ts` — Drizzle instance**

Two clients, two purposes:
- `db` — anon-context: uses Supabase session cookies, RLS applies. **Never used in Phase B** because we go through Supabase's PostgREST for query simplicity in the UI; available for future use.
- `dbAdmin` — service-role: bypasses RLS for system operations (tenant provisioning trigger backfill, admin tools). **Use sparingly and only server-side.**

For Phase B all queries flow through `@supabase/ssr`'s typed client, which respects RLS automatically. Drizzle is here for Phase C+ where we need typed inserts/joins; included now so the schema lives in TypeScript from the start.

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Single connection, prepared statements disabled (Supabase pooler in
// transaction mode doesn't support them). Phase B doesn't actually use this
// at runtime; included so Phase C onboarding migrations have it ready.
const client = postgres(connectionString, { prepare: false });
export const dbAdmin = drizzle(client, { schema });
```

- [ ] **Step 4: Generate the initial migration**

```bash
pnpm --filter @jab/web db:generate
```

Expected: `apps/web/drizzle/migrations/0000_initial_schema.sql` is created with `CREATE TABLE` statements.

- [ ] **Step 5: Add manual SQL for Supabase auth FKs + tenant trigger**

Drizzle doesn't know about `auth.users`. Hand-edit the generated migration to add the FKs + the `handle_new_user` trigger that auto-creates a profile + default tenant + membership on signup. Append this to `0000_initial_schema.sql`:

```sql
-- Foreign keys to Supabase's auth.users (Drizzle can't introspect across schemas)
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.tenant_members
  ADD CONSTRAINT tenant_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- On new user signup: create profile + default "Personal" tenant + membership.
-- Runs as the postgres role (security definer) because auth.users insert fires
-- before any RLS context exists.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_tenant_id UUID;
BEGIN
  -- 1. Profile row mirrors auth metadata.
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (new.id, new.email, COALESCE(new.raw_user_meta_data->>'display_name', new.email));

  -- 2. Default tenant. Name is the user's email — they can rename later.
  INSERT INTO public.tenants (name)
  VALUES (COALESCE(new.raw_user_meta_data->>'display_name', new.email))
  RETURNING id INTO new_tenant_id;

  -- 3. Membership as owner.
  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (new_tenant_id, new.id, 'owner');

  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

- [ ] **Step 6: Push the migration to Supabase**

```bash
pnpm --filter @jab/web db:push
```

Expected: drizzle-kit reports the four tables created, plus the trigger applied.

- [ ] **Step 7: Verify in Supabase Studio**

Open the project's Supabase Studio → Database → Tables. Should see `profiles`, `tenants`, `tenant_members`, `projects` under the `public` schema.

- [ ] **Step 8: Commit**

```bash
git add apps/web/drizzle/ apps/web/drizzle.config.ts apps/web/lib/db/
git commit -m "feat(web): drizzle schema + tenant-bootstrap trigger"
```

---

## Task 4 — Row-Level Security policies

**Files:**
- Create: `apps/web/drizzle/migrations/0001_rls_policies.sql`

This is THE file that determines whether multi-tenancy is honest or theater. Every policy MUST be correct or the SaaS is broken in a way that's invisible until a tenant sees another tenant's data. Reading it carefully is worth the time.

- [ ] **Step 1: Write `apps/web/drizzle/migrations/0001_rls_policies.sql`**

```sql
-- Helper: the set of tenant_ids the current authenticated user belongs to.
-- SECURITY DEFINER so it can read tenant_members regardless of RLS — necessary
-- because RLS on tenant_members would otherwise create a chicken-and-egg loop.
CREATE OR REPLACE FUNCTION public.current_user_tenant_ids()
RETURNS SETOF UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM public.tenant_members
  WHERE user_id = auth.uid()
$$;

-- Lock down by default. Every table gets RLS enabled; absence of a policy
-- means "deny all" for non-superuser roles.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- profiles: each user can only read/update their own row.
CREATE POLICY "profiles: own read"   ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles: own update" ON public.profiles FOR UPDATE USING (auth.uid() = id);
-- No INSERT policy — the trigger handles it as security definer. No DELETE
-- policy — users can't delete profiles directly (cascade from auth.users).

-- tenants: members can read tenants they belong to. No app-side INSERT/UPDATE/
-- DELETE for v0 — the trigger creates the default tenant on signup and that's
-- the only tenant lifecycle event Phase B supports.
CREATE POLICY "tenants: member read"
  ON public.tenants FOR SELECT
  USING (id IN (SELECT public.current_user_tenant_ids()));

-- tenant_members: members can see fellow members of shared tenants.
CREATE POLICY "tenant_members: shared read"
  ON public.tenant_members FOR SELECT
  USING (tenant_id IN (SELECT public.current_user_tenant_ids()));
-- No app-side INSERT/UPDATE/DELETE for v0; trigger handles initial owner
-- membership; invitations come in v0.5+.

-- projects: tenant scoping for all four operations.
CREATE POLICY "projects: tenant read"
  ON public.projects FOR SELECT
  USING (tenant_id IN (SELECT public.current_user_tenant_ids()));

CREATE POLICY "projects: tenant insert"
  ON public.projects FOR INSERT
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));

CREATE POLICY "projects: tenant update"
  ON public.projects FOR UPDATE
  USING (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));

CREATE POLICY "projects: tenant delete"
  ON public.projects FOR DELETE
  USING (tenant_id IN (SELECT public.current_user_tenant_ids()));
```

- [ ] **Step 2: Push to Supabase**

```bash
pnpm --filter @jab/web db:push
```

- [ ] **Step 3: Verify policies in Supabase Studio**

Database → Authentication → Policies. Each table should list the policies above.

- [ ] **Step 4: Commit**

```bash
git add apps/web/drizzle/migrations/0001_rls_policies.sql
git commit -m "feat(web): RLS policies — tenant-scoped access on every table"
```

---

## Task 5 — Supabase client wrappers

**Files:**
- Create: `apps/web/lib/supabase/client.ts`, `apps/web/lib/supabase/server.ts`, `apps/web/lib/supabase/admin.ts`

Three clients, three contexts:

| Client | Used in | RLS context | Uses |
|---|---|---|---|
| `createBrowserClient` | Client Components | User session (auth.uid() from JWT) | UI interactions, realtime subs |
| `createServerClient` | Server Components, route handlers | User session (cookies → JWT) | Most server-side reads/writes |
| `createAdminClient` | Server-only, system operations | None — bypasses RLS via service-role | Trigger backfills, cron jobs, internal admin tools |

- [ ] **Step 1: `apps/web/lib/supabase/client.ts` (browser)**

```ts
"use client";
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

- [ ] **Step 2: `apps/web/lib/supabase/server.ts` (server, RLS-respecting)**

This one's load-bearing — wires Supabase's auth tokens to Next.js's cookies API so the server-side queries run *as the user* and RLS policies apply.

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          // In Server Components, set() throws; the middleware refreshes the
          // session and writes cookies there instead. Tolerate it here.
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            /* expected in RSC; middleware handles cookie refresh */
          }
        },
      },
    },
  );
}
```

- [ ] **Step 3: `apps/web/lib/supabase/admin.ts` (service-role, bypass RLS)**

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client — bypasses RLS. Use ONLY for system operations that
 * legitimately need to act outside any tenant scope (cron jobs, admin tooling).
 *
 * NEVER call from a route handler that takes user input without re-checking
 * tenant scope manually. This is the one knife in the kitchen that can cut
 * through every safety boundary.
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/supabase/
git commit -m "feat(web): Supabase client wrappers (browser + server-RLS + service-role)"
```

---

## Task 6 — Auth middleware (session refresh + route guard)

**Files:**
- Create: `apps/web/middleware.ts`

`@supabase/ssr` requires a middleware that runs on every request to refresh the session token before it expires. We extend it to redirect unauthenticated requests away from `(app)/*` routes.

- [ ] **Step 1: `apps/web/middleware.ts`**

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_ROUTES = ["/", "/sign-in", "/auth/callback"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Don't getUser() across the board — only when we actually need to gate.
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_ROUTES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  if (!isPublic) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = "/sign-in";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Skip Next.js internals and static assets — every other route gets
    // session refresh + the gate above.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
```

---

## Task 7 — Auth UI (sign-in / sign-up combined)

**Files:**
- Create: `apps/web/app/(auth)/layout.tsx`, `apps/web/app/(auth)/sign-in/page.tsx`, `apps/web/app/auth/callback/route.ts`

For Phase B we use email + password (simplest; no SMTP setup). Magic links / OAuth come later.

- [ ] **Step 1: `apps/web/app/(auth)/layout.tsx`** — centered card layout. Tailwind only.

- [ ] **Step 2: `apps/web/app/(auth)/sign-in/page.tsx`** — Client Component with sign-in/sign-up toggle. Uses `createBrowserClient` to call `auth.signInWithPassword` / `auth.signUp`. On success, redirects to `searchParams.next ?? "/dashboard"`.

Important UX detail: sign-up via Supabase by default sends a confirmation email. For local dev, disable email confirmation in Supabase Auth settings → Email Auth → "Confirm email" off. Document this in `.env.local.example` comments.

- [ ] **Step 3: `apps/web/app/auth/callback/route.ts`** — handles email-confirmation redirects. Wires `code` query param into `supabase.auth.exchangeCodeForSession`. Required for production-mode auth even if email confirm is off in dev.

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }
  return NextResponse.redirect(`${origin}/sign-in?error=auth-callback-failed`);
}
```

- [ ] **Step 4: Verify end-to-end**

  1. `pnpm --filter @jab/web dev`
  2. Visit `/sign-in`
  3. Sign up with `test@example.com` + password
  4. Redirected to `/dashboard` (404 for now — Task 8)
  5. In Supabase Studio → SQL Editor: `SELECT * FROM tenants; SELECT * FROM tenant_members; SELECT * FROM profiles;`
  6. Expected: one row in each, all linked correctly.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/(auth)/ apps/web/app/auth/ apps/web/middleware.ts
git commit -m "feat(web): email/password auth + middleware route guard"
```

---

## Task 8 — Dashboard + projects list

**Files:**
- Create: `apps/web/app/(app)/layout.tsx`, `apps/web/app/(app)/dashboard/page.tsx`

- [ ] **Step 1: `apps/web/app/(app)/layout.tsx`** — sidebar nav (Dashboard, Projects, future: Settings) + top header (user email + sign out). Server Component pulling user info via `createClient()` from `lib/supabase/server.ts`.

- [ ] **Step 2: `apps/web/app/(app)/dashboard/page.tsx`** — Server Component that fetches projects:

```tsx
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, name, client_name, wp_url, status, created_at")
    .order("created_at", { ascending: false });

  if (error) throw error;

  if (!projects || projects.length === 0) {
    return (
      <EmptyState>
        <h1>No projects yet</h1>
        <Link href="/projects/new" className="...">Create your first project</Link>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Link href="/projects/new" className="...">New Project</Link>
      </header>
      <ul className="space-y-2">
        {projects.map((p) => (
          <li key={p.id}>
            <Link href={`/projects/${p.id}`}>
              <h2>{p.name}</h2>
              <p>{p.client_name} · {p.wp_url} · {p.status}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

The RLS policy auto-scopes the query to projects in the user's tenants — no explicit `.eq("tenant_id", ...)` needed in app code. **This is the load-bearing point**: trust the database to enforce the boundary, not the app code.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/(app)/
git commit -m "feat(web): dashboard layout + projects list"
```

---

## Task 9 — Create project flow

**Files:**
- Create: `apps/web/app/(app)/projects/new/page.tsx`, `apps/web/lib/actions/projects.ts`

- [ ] **Step 1: Server action `apps/web/lib/actions/projects.ts`**

```ts
"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const CreateProjectInput = z.object({
  name: z.string().min(1).max(100),
  clientName: z.string().min(1).max(100),
  wpUrl: z.string().url().refine((v) => /^https?:\/\//.test(v), "Must be http(s) URL"),
});

export async function createProject(formData: FormData): Promise<void> {
  const parsed = CreateProjectInput.safeParse({
    name: formData.get("name"),
    clientName: formData.get("clientName"),
    wpUrl: formData.get("wpUrl"),
  });
  if (!parsed.success) {
    throw new Error(parsed.error.errors.map((e) => e.message).join("; "));
  }

  const supabase = await createClient();

  // Look up the user's first tenant. v0: each user has exactly one tenant
  // (auto-provisioned on signup), so this is unambiguous. Phase v1+ will add
  // a tenant picker for users who belong to multiple.
  const { data: memberships, error: mErr } = await supabase
    .from("tenant_members").select("tenant_id").limit(1);
  if (mErr) throw mErr;
  if (!memberships || memberships.length === 0) {
    throw new Error("No tenant for current user — bootstrap trigger may have failed");
  }
  const tenantId = memberships[0]!.tenant_id;

  const { data: project, error } = await supabase
    .from("projects")
    .insert({
      tenant_id: tenantId,
      name: parsed.data.name,
      client_name: parsed.data.clientName,
      wp_url: parsed.data.wpUrl,
      status: "draft",
    })
    .select("id")
    .single();
  if (error) throw error;

  redirect(`/projects/${project.id}`);
}
```

- [ ] **Step 2: Form page `apps/web/app/(app)/projects/new/page.tsx`** — uses the server action via `<form action={createProject}>`. Three text inputs (name, client name, WP URL) + submit. No JavaScript needed.

- [ ] **Step 3: Verify**

  1. Click "New Project" from dashboard
  2. Fill in: name="Test", client="Acme Inc", URL="https://acme.com"
  3. Submit → redirected to `/projects/[id]`
  4. Back to dashboard → project appears

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/(app)/projects/new/ apps/web/lib/actions/
git commit -m "feat(web): create project form + server action"
```

---

## Task 10 — Project detail page

**Files:**
- Create: `apps/web/app/(app)/projects/[id]/page.tsx`

- [ ] **Step 1: Project detail Server Component** — fetches by id, displays metadata, Phase-C placeholder.

```tsx
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function ProjectDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  // RLS returns 0 rows when the project belongs to another tenant. PGRST116
  // is the "no rows returned" code — surface as 404 so cross-tenant probing
  // is indistinguishable from "doesn't exist."
  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  return (
    <article className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold">{project.name}</h1>
        <p className="text-slate-600">
          {project.client_name} · <a href={project.wp_url}>{project.wp_url}</a>
        </p>
        <span className="...">{project.status}</span>
      </header>

      <section className="rounded-lg border border-dashed p-6 text-center text-slate-500">
        Onboarding wizard arrives in Phase C — install the Jab plugin on the
        client&apos;s WordPress site, paste WP credentials, connect a GitHub
        repo, and we&apos;ll fetch the abilities manifest.
      </section>
    </article>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/(app)/projects/[id]/
git commit -m "feat(web): project detail page (Phase C placeholder)"
```

---

## Task 11 — Cross-tenant isolation test (acceptance gate)

**Files:**
- Create: `apps/web/scripts/test-tenant-isolation.sql` (committed; runnable from Supabase SQL editor)

Manual verification gate. If this fails, multi-tenancy is broken; do NOT proceed to Phase C.

- [ ] **Step 1: Write the test SQL**

```sql
-- Run as postgres role (bypasses RLS) to set up state.
-- Inputs (replace before running):
--   :user_a_id  — UUID from auth.users for user A
--   :user_b_id  — UUID from auth.users for user B

-- Verify each user got exactly one tenant from the trigger.
SELECT user_id, COUNT(*) FROM public.tenant_members GROUP BY user_id;
-- Expected: user_a_id → 1, user_b_id → 1

-- Insert a project as user A (using their tenant_id).
INSERT INTO public.projects (tenant_id, name, client_name, wp_url)
SELECT tenant_id, 'A''s secret project', 'Confidential Client', 'https://a.example.com'
FROM public.tenant_members WHERE user_id = :user_a_id;

-- Now switch to user B's role context.
SET LOCAL role TO authenticated;
SET LOCAL request.jwt.claim.sub TO :user_b_id::text;

-- ❌ Should return 0 rows.
SELECT * FROM public.projects WHERE name = 'A''s secret project';

-- ❌ INSERT into A's tenant_id should fail / return 0 rows affected.
INSERT INTO public.projects (tenant_id, name, client_name, wp_url)
SELECT tenant_id, 'B trying to inject', 'pwned', 'https://b.example.com'
FROM public.tenant_members WHERE user_id = :user_a_id;

-- Reset.
RESET role;
```

- [ ] **Step 2: Run the test in Supabase SQL Editor with two real signed-up test accounts**

Each ❌ assertion above must hold. If any leaks, Phase B FAILS.

- [ ] **Step 3: Commit the test SQL for posterity**

```bash
git add apps/web/scripts/
git commit -m "test(web): cross-tenant isolation acceptance test"
```

---

## Task 12 — Update CLAUDE.md (capture the strategic shift)

**Files:**
- Modify: `CLAUDE.md` (project root)

The current [CLAUDE.md](../../../CLAUDE.md) lists *"Adding a hosted dashboard or SaaS surface before two paying agency customers exist"* as an anti-pattern. We're now revisiting it on the basis of customer-pull signal. Document the reasoning so future-you (and future maintainers) understand the strategic shift.

- [ ] **Step 1: Update the Anti-patterns section**

Edit the bullet to read:

```markdown
- ~~Adding a hosted dashboard or SaaS surface before two paying agency
  customers exist.~~ **Revisited 2026-05-08:** real customer-pull signal
  in market. v0 SaaS is being built (`apps/web/`) with the smallest possible
  surface (single-page AI generator) to validate that demand converts to
  revenue. See [`docs/superpowers/plans/steady-frolicking-wind.md`](docs/superpowers/plans/steady-frolicking-wind.md) for
  the v0 plan and rationale. Original rule remains valuable as a reminder:
  the moat is still developer experience, not the dashboard chrome.
```

- [ ] **Step 2: Add a new section "## Repository structure" update**

Add `apps/web/` to the repo-layout diagram:

```markdown
wp-headless-kit/  →  jab/
├── packages/
│   ├── wp-plugin/       # PHP — installed on client WP
│   ├── core/            # @jab/core — pure-function engine (NEW Phase A)
│   └── cli/             # @jab/wp-headless-cli — local-first CLI
└── apps/
    └── web/             # @jab/web — multi-tenant SaaS shell (Phase B+)
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update anti-pattern with customer-pull rationale + record SaaS pivot"
```

---

## Task 13 — Production build smoke test

- [ ] **Step 1: `pnpm --filter @jab/web build`**

Expected: Next.js builds without type or lint errors. Output shows the four `(app)/*` routes + the `(auth)/*` routes detected as dynamic (since they hit Supabase per request).

- [ ] **Step 2: `pnpm --filter @jab/web start`** (briefly, then ctrl-C) — production server boots clean.

If either fails: fix and re-test before declaring Phase B done.

- [ ] **Step 3: Final tag commit (optional)**

```bash
git tag phase-b-complete
```

---

## Risks to watch (Phase B specific)

1. **Supabase trigger silent failure.** If the `handle_new_user` trigger errors (e.g., schema mismatch), signup appears to succeed at the auth layer but no profile/tenant rows exist. User then hits "No tenant for current user" in the create-project flow. Defense: explicit verification step in Task 7's checklist, plus a TODO to add a fallback "if missing, create on first dashboard visit."
2. **Service-role key leakage.** Easiest mistake: accidentally importing `lib/supabase/admin.ts` from a Client Component. The file uses `import "server-only"` to crash the build if it ever happens. Don't remove that line.
3. **RLS bypass via `dbAdmin`.** Phase B doesn't use `dbAdmin` for any user-facing query. Phase C onboarding likely will (storing encrypted credentials). Audit every `dbAdmin` call when reviewing Phase C — each one needs an explicit comment justifying why bypass is safe.
4. **Cookie-session edge cases.** `@supabase/ssr` cookie writes throw in Server Components by design — middleware handles refresh. If you see "cookies can only be modified in a server action or route handler" errors at runtime, the middleware matcher likely has a bug.
5. **First-tenant assumption breaks under invitations.** The `lib/actions/projects.ts` createProject action picks `memberships[0]?.tenant_id` for v0. When invitations land (v1), this needs a tenant picker.

## Out of scope for Phase B (deferred)

- Magic-link auth, OAuth providers, MFA — email/password only
- Tenant invitations / multi-user agencies — single user per tenant for now
- Tenant rename / settings page
- Project edit / delete (only create + read in Phase B; CRUD-complete in Phase C)
- Manifest fetch, plugin probe, GitHub integration (Phase C)
- AI generation (Phase D)
- Billing, usage metering, plan tiers
- Tenant-aware audit logging
- Drizzle Studio integration in CI / staging

---

## Verification (Phase B done when all of these are true)

- [ ] `pnpm install` from repo root resolves cleanly (no peer warnings beyond the known ones)
- [ ] `pnpm --filter @jab/web dev` starts a Next.js dev server on port 3000
- [ ] `pnpm --filter @jab/web build` produces a production build with zero type errors
- [ ] Two test accounts signed up successfully; each has exactly one tenant + one tenant_members row + one profile (verified in Supabase Studio)
- [ ] Account A creates a project; account B cannot see it (verified via UI navigation AND the SQL test in Task 11)
- [ ] [`CLAUDE.md`](../../../CLAUDE.md) anti-pattern updated with rationale
- [ ] All commits include `Co-Authored-By: Claude` line
- [ ] Phase B tag pushed (or just commit history clean)

When all checked, Phase C (onboarding wizard) starts with a real foundation under it.
