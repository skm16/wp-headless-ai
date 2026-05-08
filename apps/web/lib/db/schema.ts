/**
 * Drizzle schema — TypeScript source of truth for the Postgres tables.
 *
 * Mirrors `apps/web/drizzle/migrations/0000_initial_schema.sql`. If you change
 * one, change the other — drift between them silently breaks RLS scoping or
 * insert/update calls, in ways that only surface in production.
 *
 * What's NOT here: Supabase's `auth.users` table (managed by Supabase Auth;
 * we treat it as an external system and FK into it via plain UUID columns).
 */

import { pgTable, uuid, text, timestamp, primaryKey, index, customType, jsonb } from "drizzle-orm/pg-core";

/**
 * `bytea` column type — Drizzle ships sql-level support but no first-class
 * helper. We pass and receive Node Buffers (the `pg`/`postgres` driver does
 * the binary encoding).
 */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Mirrors the user-controllable subset of `auth.users`. Created by the
 * `handle_new_user` trigger on `auth.users` insert (see migration 0000).
 * App code never inserts here directly — Supabase auth owns the lifecycle.
 */
export const profiles = pgTable("profiles", {
  // FK to auth.users(id) — enforced at the SQL level (Drizzle can't
  // introspect the auth schema, so the constraint lives in the .sql file).
  id: uuid("id").primaryKey(),
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
    // FK to auth.users(id) — see profiles.id comment above.
    userId: uuid("user_id").notNull(),
    // 'owner' | 'admin' | 'member' — string-typed for now; convert to a
    // pg_enum once role behaviors diverge meaningfully.
    role: text("role").notNull().default("owner"),
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
    // 'draft' | 'onboarding' | 'ready' | 'archived' — Phase B uses 'draft'
    // and 'onboarding'; later phases populate the rest.
    status: text("status").notNull().default("draft"),
    // Onboarding state — populated by Phase C wizard. Probe-first ordering
    // means these are only set once we've verified the WP creds work.
    wpUsername: text("wp_username"),
    wpAppPasswordEncrypted: bytea("wp_app_password_encrypted"),
    githubRepoFullName: text("github_repo_full_name"),
    githubPatEncrypted: bytea("github_pat_encrypted"),
    manifest: jsonb("manifest"),
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ tenantIdx: index("projects_tenant_id_idx").on(t.tenantId) }),
);
