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

import { pgTable, uuid, text, timestamp, primaryKey, index, customType, jsonb, integer } from "drizzle-orm/pg-core";

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
    // Captured-asset paths copied from `anonymous_previews` at signup-promote.
    // Stage 2 (post-signup probe) will refresh these from the connected WP
    // homepage; the values here are the wow-preview snapshot.
    logoStoragePath: text("logo_storage_path"),
    faviconStoragePath: text("favicon_storage_path"),
    ogImageStoragePath: text("og_image_storage_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ tenantIdx: index("projects_tenant_id_idx").on(t.tenantId) }),
);

/**
 * Generic hourly fixed-window rate-limit counters. Caller picks the key
 * namespace — see `lib/rate-limit.ts`. All access is service-role; the
 * table has RLS enabled with no policies for anon/authenticated.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    hits: integer("hits").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
);

/**
 * Pre-auth `/preview` generations — keyed by session cookie, not user.
 * Mirrors `apps/web/drizzle/migrations/0005_anonymous_previews.sql`.
 *
 * All access is server-side via `createAdminClient()`. The table has RLS
 * enabled with no policies — anon / authenticated / tenant owners are all
 * denied; only service-role bypass reads.
 */
export const anonymousPreviews = pgTable(
  "anonymous_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    finalUrl: text("final_url"),
    // 'queued' | 'running' | 'succeeded' | 'failed'
    status: text("status").notNull().default("queued"),
    error: text("error"),
    contentMarkdown: text("content_markdown"),
    design: jsonb("design"),
    extract: jsonb("extract"),
    generatedHtml: text("generated_html"),
    model: text("model"),
    usage: jsonb("usage"),
    byteSize: integer("byte_size"),
    // Captured-asset paths (bucket-relative, in `project-assets`).
    // Set by the scrape-preview worker's capture-assets step; promoted to
    // `projects` on signup. NULL means capture failed or no asset found.
    logoStoragePath: text("logo_storage_path"),
    faviconStoragePath: text("favicon_storage_path"),
    ogImageStoragePath: text("og_image_storage_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    promotedToProjectId: uuid("promoted_to_project_id").references(() => projects.id, { onDelete: "set null" }),
  },
  (t) => ({
    sessionIdx: index("anonymous_previews_session_id_idx").on(t.sessionId),
  }),
);

/**
 * AI page-generation job records. One row per "Generate" button click.
 * Worker writes via service-role; users read via RLS scoped through
 * project_id → tenants.
 */
export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pagePath: text("page_path").notNull(),

    // 'queued' | 'running' | 'succeeded' | 'failed'
    status: text("status").notNull().default("queued"),
    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),

    outputPath: text("output_path"),
    outputBranch: text("output_branch"),
    outputCommitSha: text("output_commit_sha"),
    generatedCode: text("generated_code"),
  },
  (t) => ({
    projectIdx: index("generation_jobs_project_id_idx").on(t.projectId),
    statusIdx: index("generation_jobs_status_idx").on(t.status),
  }),
);
