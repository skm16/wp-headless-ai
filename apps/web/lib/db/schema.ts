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

import { pgTable, uuid, text, timestamp, primaryKey, index, uniqueIndex, customType, jsonb, integer, boolean, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    // 'draft' | 'onboarding' | 'ready' | 'archived'
    status: text("status").notNull().default("draft"),
    wpUsername: text("wp_username"),
    wpAppPasswordEncrypted: bytea("wp_app_password_encrypted"),
    vercelProjectId: text("vercel_project_id"),
    vercelProjectName: text("vercel_project_name"),
    githubRepoFullName: text("github_repo_full_name"),
    githubPatEncrypted: bytea("github_pat_encrypted"),
    manifest: jsonb("manifest"),
    // Plugin version reported by /wp-json/jab/v1/manifest at last successful
    // connect (migration 0025). NULL when unreported (pre-v0.7.0 plugin or the
    // fail-soft fetch returned nothing).
    wpPluginVersion: text("wp_plugin_version"),
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    // Captured-asset paths populated by the design-token extraction worker
    // (extractProjectDesign). NULL until that worker has run.
    logoStoragePath: text("logo_storage_path"),
    faviconStoragePath: text("favicon_storage_path"),
    ogImageStoragePath: text("og_image_storage_path"),
    // Design-extraction output (one-shot at onboarding completion).
    // DesignAnalysis minus the personality block, which lives on its own
    // column. NULL until the post-probe worker completes.
    designTokens: jsonb("design_tokens"),
    personality: jsonb("personality"),
    // Onboarding wizard state. NULL until the corresponding wizard step
    // completes. intent retained per Stage 0 decision #2 — retirement
    // happens in Stage 2 alongside the component-shaped prompts.
    intent: text("intent"),
    contentOwnership: jsonb("content_ownership"),
    // Migration 0034 — design-pass usage telemetry written by the scrape
    // worker: { primary: {model,inputTokens,outputTokens}, fallback?,
    // fallbackUsed, at }. Includes the wasted primary call when the
    // Haiku→Sonnet fallback fires. NULL until the worker has run post-0034.
    designScrapeUsage: jsonb("design_scrape_usage"),
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

/**
 * site_builds — one row per build attempt. Mirrors migration 0014.
 *
 * Status machine values are enforced by the SQL CHECK constraint and the
 * client-side union type `SiteBuildStatus`; Drizzle doesn't model CHECKs.
 */
export const siteBuilds = pgTable(
  "site_builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    previewUrl: text("preview_url"),
    vercelDeploymentId: text("vercel_deployment_id"),
    buildLogStoragePath: text("build_log_storage_path"),
    failedPhase: text("failed_phase"),
    errorText: text("error_text"),
    pageCount: integer("page_count"),
    blockTypeCount: integer("block_type_count"),
    componentCount: integer("component_count"),
    // NUMERIC(...) in the SQL migration. We type as `text` rather than Drizzle's
    // `numeric()` so that the TS file isn't a source-of-truth for DDL — the
    // .sql migration is canonical. The runtime value is a string regardless
    // (postgres.js coerces NUMERIC → string), so parse at the call site if you
    // need a JS number.
    fidelityAvg: text("fidelity_avg"),
    // Measured home-route navigation-timing perf (migration 0028). Captured
    // inside the verify-fidelity Playwright pass; NULL for pre-0028 builds or
    // when perf capture fails (fail-soft). transferBytes is BIGINT — postgres.js
    // returns it as a string, so parse at the call site if you need a JS number.
    ttfbMs: integer("ttfb_ms"),
    loadMs: integer("load_ms"),
    transferBytes: text("transfer_bytes"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    config: jsonb("config").notNull().default({}),
  },
  (t) => ({
    projectIdx: index("site_builds_project_id_idx").on(t.projectId),
    statusIdx: index("site_builds_status_idx").on(t.status),
    // At most one ACTIVE (non-queued) build per project (migration 0031).
    // Partial: only indexes rows whose status is an active phase, excluding
    // 'queued' (spec §3.4). The hard backstop behind the app-level check.
    oneActivePerProjectIdx: uniqueIndex("site_builds_one_active_per_project_idx")
      .on(t.projectId)
      .where(sql`status IN ('discovering', 'components', 'composing', 'building', 'verifying')`),
  }),
);

/**
 * deployments — preview + production URL tracking. Mirrors migration 0014.
 */
export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteBuildId: uuid("site_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: text("environment").notNull(),
    status: text("status").notNull().default("pending"),
    url: text("url"),
    provider: text("provider"),
    providerDeploymentId: text("provider_deployment_id"),
    buildLogExcerpt: text("build_log_excerpt"),
    promotedFromDeploymentId: uuid("promoted_from_deployment_id")
      .references((): AnyPgColumn => deployments.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => ({
    siteBuildIdx: index("deployments_site_build_id_idx").on(t.siteBuildId),
    projectIdx: index("deployments_project_id_idx").on(t.projectId),
    envStatusIdx: index("deployments_env_status_idx").on(t.environment, t.status),
  }),
);

/**
 * block_inventory — per-build unique block-type catalog with cost telemetry.
 * Cost-telemetry columns are written by Stage 2 (per design doc §6.4 + §6.7).
 */
export const blockInventory = pgTable(
  "block_inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteBuildId: uuid("site_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    blockName: text("block_name").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(0),
    // text[] mapping — drizzle's `text("name").array()` materializes as text[].
    pageSlugs: text("page_slugs").array().notNull().default([]),
    attrSamples: jsonb("attr_samples").notNull().default([]),
    computedStyles: jsonb("computed_styles"),
    // Stage 2 patch (migration 0019) — outerHTML sample of this block from
    // the source page DOM. Populated by aggregate-dom-samples. NULL when
    // correlation was ambiguous or the theme doesn't emit `wp-block-*`
    // classes and the block has no positional/article fallback.
    sourceDomSample: text("source_dom_sample"),
    tier: text("tier"),
    modelUsed: text("model_used"),
    providerUsed: text("provider_used"),
    inputTokensCached: integer("input_tokens_cached"),
    inputTokensUncached: integer("input_tokens_uncached"),
    outputTokens: integer("output_tokens"),
    compileStatus: text("compile_status"),
    // SQL is SMALLINT; we use integer() here because both return `number` in TS
    // and the .sql migration is the DDL source. Functionally identical for
    // reads; SMALLINT bound enforced by the CHECK constraint at the DB layer.
    compileAttemptCount: integer("compile_attempt_count"),
    // Stage 2 (migration 0015) — kind discriminates entry type for Phase B
    // routing; spec carries per-kind structured context (ACF flex sub_fields,
    // CPT template block union). See 0015_inventory_kind_spec.sql for the
    // CHECK constraint enforcing kind IN ('block', 'acf_flex', 'cpt_template').
    kind: text("kind").notNull().default("block").$type<"block" | "acf_flex" | "cpt_template">(),
    spec: jsonb("spec"),
    // ── Migration 0034 (AI-call-optimization Phase 1) ──
    // Cache-write tokens (billed 1.25x). Total prompt = uncached + creation
    // + cached; cost = 1.0x uncached + 1.25x creation + 0.1x cached.
    inputTokensCacheCreation: integer("input_tokens_cache_creation").notNull().default(0),
    // Typed failure class (lib/ai/errors.ts AiFailureKind + "max_tokens").
    failureKind: text("failure_kind"),
    // Phase 4 carry-forward: sha256 of prompt inputs + provenance pointer.
    promptInputsHash: text("prompt_inputs_hash"),
    reusedFromBuildId: uuid("reused_from_build_id").references(() => siteBuilds.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteBuildIdx: index("block_inventory_site_build_id_idx").on(t.siteBuildId),
    projectIdx: index("block_inventory_project_id_idx").on(t.projectId),
    buildBlockNameIdx: uniqueIndex("block_inventory_build_block_name_idx").on(t.siteBuildId, t.blockName),
  }),
);

/**
 * page_inventory — per-build list of pages to render.
 */
export const pageInventory = pgTable(
  "page_inventory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteBuildId: uuid("site_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    postType: text("post_type").notNull(),
    title: text("title"),
    routePath: text("route_path").notNull(),
    blockCount: integer("block_count").notNull().default(0),
    sourceScreenshotPaths: jsonb("source_screenshot_paths").notNull().default({}),
    rendering: text("rendering").notNull().default("dynamic"),
    paradigms: text("paradigms").array().notNull().default([]),
    // Absolute source permalink captured at discovery (migration 0033).
    // NULL for pre-0033 rows. Drives the compose-time sourcePath→route_path
    // rewrite map (buildRoutePathMap).
    link: text("link"),
    // WP modified_gmt of the source post at discovery time (migration 0026).
    // NULL when unknown. Drives Phase 7 incremental re-sync.
    sourceModifiedGmt: timestamp("source_modified_gmt", { withTimezone: true }),
    // Raw WP BlockNode[] captured at discovery (migration 0027). Source of
    // truth for incremental carry-forward — a re-build re-aggregates
    // block_inventory from stored trees instead of re-fetching unchanged
    // pages. NULL for pre-0027 rows.
    blockTree: jsonb("block_tree"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteBuildIdx: index("page_inventory_site_build_id_idx").on(t.siteBuildId),
    projectIdx: index("page_inventory_project_id_idx").on(t.projectId),
    buildSlugTypeIdx: uniqueIndex("page_inventory_build_slug_type_idx").on(t.siteBuildId, t.slug, t.postType),
  }),
);

/**
 * fidelity_reports — per-page-per-build fidelity score + structured issues.
 */
export const fidelityReports = pgTable(
  "fidelity_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteBuildId: uuid("site_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageInventoryId: uuid("page_inventory_id")
      .notNull()
      .references(() => pageInventory.id, { onDelete: "cascade" }),
    // NUMERIC(...) typed as text — see siteBuilds.fidelityAvg.
    score: text("score"),
    pixelDiff: text("pixel_diff"),
    issues: jsonb("issues").notNull().default([]),
    approvalStatus: text("approval_status").notNull().default("pending"),
    approvedByUserId: uuid("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    generatedScreenshotPaths: jsonb("generated_screenshot_paths").notNull().default({}),
    // Per-viewport fidelity breakdown (migration 0036). Keyed by viewport
    // width as a string: { "1280": {...}, "375": {...} }. The top-level
    // score/pixel_diff columns stay the canonical DESKTOP (1280) values so
    // every existing consumer is unchanged; this carries the mobile axis.
    viewportScores: jsonb("viewport_scores").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteBuildIdx: index("fidelity_reports_site_build_id_idx").on(t.siteBuildId),
    projectIdx: index("fidelity_reports_project_id_idx").on(t.projectId),
    buildPageIdx: uniqueIndex("fidelity_reports_build_page_idx").on(t.siteBuildId, t.pageInventoryId),
  }),
);

/**
 * workspace_edits — Phase 7 of the 2026-06-02 SaaS-app completion plan.
 * One row per user-issued targeted edit request. Mirrors migration 0024.
 */
export const workspaceEdits = pgTable(
  "workspace_edits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sourceBuildId: uuid("source_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    resultBuildId: uuid("result_build_id").references(
      () => siteBuilds.id,
      { onDelete: "set null" },
    ),
    userId: uuid("user_id").notNull(),
    scope: text("scope").$type<"component" | "shell" | "tokens" | "page">().notNull(),
    target: text("target").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "failed" | "discarded">()
      .notNull()
      .default("queued"),
    errorText: text("error_text"),
    // Provenance columns (migration 0030, e2e-loop §2.3). Guidance threaded
    // into the generator; the chat message that triggered the edit; the
    // computed changed-page set + reason; and the promoted production
    // deployment that closes the audit chain.
    regenerationPrompt: text("regeneration_prompt"),
    action: text("action"),
    messageId: uuid("message_id").references((): AnyPgColumn => chatMessages.id, { onDelete: "set null" }),
    changedSlugs: text("changed_slugs").array(),
    changeReason: text("change_reason").$type<"component_pages" | "shell_all" | null>(),
    resultPromotedDeploymentId: uuid("result_promoted_deployment_id").references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Live Draft linkage (migration 0035). NULL for pre-draft or build-based edits.
    draftId: uuid("draft_id").references((): AnyPgColumn => drafts.id, { onDelete: "set null" }),
    unitVersionId: uuid("unit_version_id").references(
      (): AnyPgColumn => draftUnitVersions.id,
      { onDelete: "set null" },
    ),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    // Migration 0037 — structured brand-token change for scope="tokens" edits;
    // NULL otherwise. Deterministic apply (no patch LLM): merged into the base
    // build's tokens before the draft CSS rebuild. Rides the draft undo/revert
    // machinery via active = status='completed' AND undone_at IS NULL.
    tokenDelta: jsonb("token_delta"),
  },
  (t) => ({
    projectIdx: index("workspace_edits_project_id_idx").on(t.projectId),
    sourceBuildIdx: index("workspace_edits_source_build_id_idx").on(
      t.sourceBuildId,
    ),
    resultBuildIdx: index("workspace_edits_result_build_id_idx").on(
      t.resultBuildId,
    ),
    // Migration 0032: FK indexes so ON DELETE SET NULL sweeps are not full-table scans.
    messageIdx: index("workspace_edits_message_id_idx").on(t.messageId),
    promotedDeploymentIdx: index("workspace_edits_result_promoted_deployment_id_idx").on(t.resultPromotedDeploymentId),
    // Migration 0035: draft linkage index.
    draftIdx: index("workspace_edits_draft_idx").on(t.draftId),
  }),
);

/**
 * shell_generations — per-shell cost telemetry for Phase C's Header + Footer
 * LLM calls. Mirror of block_inventory's cost columns.
 */
export const shellGenerations = pgTable(
  "shell_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteBuildId: uuid("site_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    shellKind: text("shell_kind").$type<"header" | "footer">().notNull(),
    modelUsed: text("model_used"),
    providerUsed: text("provider_used"),
    inputTokensCached: integer("input_tokens_cached"),
    inputTokensUncached: integer("input_tokens_uncached"),
    outputTokens: integer("output_tokens"),
    compileStatus: text("compile_status"),
    compileAttemptCount: integer("compile_attempt_count"),
    // Migration 0034 — see blockInventory's matching columns.
    inputTokensCacheCreation: integer("input_tokens_cache_creation").notNull().default(0),
    failureKind: text("failure_kind"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    buildKindIdx: uniqueIndex("shell_generations_build_kind_idx").on(t.siteBuildId, t.shellKind),
    projectIdx: index("shell_generations_project_id_idx").on(t.projectId),
  }),
);

/**
 * conversations — workspace chat threads (migration 0029, e2e-loop §2.7).
 * v1: one active thread per project. RLS SELECT by tenant membership; all
 * writes go through the server action's service-role admin client.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").notNull(),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index("conversations_project_idx").on(t.projectId, t.createdAt),
    // Migration 0032: v1 one-thread-per-project invariant becomes DB-enforced.
    // ensureConversation inserts against this and re-selects on 23505.
    onePerProjectIdx: uniqueIndex("conversations_one_per_project_idx").on(t.projectId),
  }),
);

/**
 * chat_messages — user + assistant turns (migration 0029, e2e-loop §2.7).
 * `plan` carries the EditPlan audit on assistant rows; edit_id / build_id link
 * a turn to the edit + result build it produced.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    plan: jsonb("plan"),
    needsClarification: boolean("needs_clarification").notNull().default(false),
    editId: uuid("edit_id").references(() => workspaceEdits.id, { onDelete: "set null" }),
    buildId: uuid("build_id").references(() => siteBuilds.id, { onDelete: "set null" }),
    inputTokensCached: integer("input_tokens_cached").notNull().default(0),
    inputTokensUncached: integer("input_tokens_uncached").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    conversationIdx: index("chat_messages_conversation_idx").on(t.conversationId, t.createdAt),
    // Migration 0032: hot-path index (assertEditBudget scans by project+time on every chat turn).
    projectCreatedIdx: index("chat_messages_project_created_idx").on(t.projectId, t.createdAt),
    // Migration 0032: FK indexes so ON DELETE SET NULL sweeps are not full-table scans.
    editIdx: index("chat_messages_edit_id_idx").on(t.editId),
    buildIdx: index("chat_messages_build_id_idx").on(t.buildId),
  }),
);

/**
 * drafts — one live draft per project (Live Draft system, migration 0035).
 * Status machine: active → publishing → published | discarded.
 * drafts_one_active_per_project_idx enforces one active/publishing draft per project.
 */
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    baseBuildId: uuid("base_build_id")
      .notNull()
      .references(() => siteBuilds.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(0),
    status: text("status").notNull().default("active").$type<"active" | "publishing" | "published" | "discarded">(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index("drafts_project_id_idx").on(t.projectId),
  }),
);

/**
 * draft_unit_versions — immutable per-unit TSX snapshots (migration 0035).
 * One row per edit per unit_key. Undo reads these in reverse chronological
 * order. version_no is per-unit monotonic — never reused across undo.
 */
export const draftUnitVersions = pgTable(
  "draft_unit_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    unitKey: text("unit_key").notNull(),
    versionNo: integer("version_no").notNull(),
    tsx: text("tsx").notNull(),
    createdByEditId: uuid("created_by_edit_id").references(
      () => workspaceEdits.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    draftIdx: index("draft_unit_versions_draft_idx").on(t.draftId),
    projectIdx: index("draft_unit_versions_project_id_idx").on(t.projectId),
  }),
);
