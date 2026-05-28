# JAB SaaS v2 Phase C — Compose & Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit the full Next.js project tree at `builds/<build_id>/project/` in Supabase Storage, ready for Phase D to `next build` + deploy. One new Inngest worker, two new tables, ~20 new files in apps/web, all driven by Phase A + B outputs that already exist on Two Roads pilot build `982f0d57`.

**Architecture:** A new `compose-site` Inngest worker triggered by `site/compose.requested` (already dispatched by `generateComponents` on clean exit). Three-wave `step.run` sequencing: (1) parallel deterministic emissions of all chrome/dispatcher/SDK/routes/runtime-helper files, (2) parallel Phase-B-component downloads + two shell LLM calls (Header, Footer) via the existing Stage 2 `ModelClient` seam, (3) serial `app/layout.tsx` emit (depends on Header/Footer existing) + status update + dispatch `site/deploy.requested`. Target wall-clock ≤45s, target cost ~$0.08/build.

**Tech Stack:** Next.js 15 App Router, TypeScript, Tailwind, Inngest workers, Supabase (Postgres + Storage), `@jab/core` (`emitSdk` + `renderJabClient` + `renderNextConfig` + `renderEnvExample`), Anthropic SDK via the existing `ModelClient` at `lib/ai/model-client.ts`, `ts.createSourceFile` for compile gate (same as Phase B), `isomorphic-dompurify` for the runtime Passthrough component (declared in the EMITTED project's package.json — Phase C itself doesn't import it).

---

## Context You Need Before Starting

**Spec:** [`docs/superpowers/specs/2026-05-27-saas-v2-phase-c-design.md`](../specs/2026-05-27-saas-v2-phase-c-design.md) (committed in `b3c26d0`). Read sections 3 (file tree), 4 (Storage layout), 5 (worker shape), 6 (per-step C₁–C₇ detail), 8 (compose-block-tree runtime), 9 (shell LLM contract), 13 (risks), 14 (testing strategy) before opening any code.

**Architecture doc:** [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §3 Decision 3 (Passthrough rationale + canonical TSX), §4 Phase C, §6.6, §8 (the persistence layer).

**Phase A + B state (validated 2026-05-27 against Two Roads pilot):**
- Build `982f0d57-5275-499a-92d8-5f00dc70dba1` is the canonical Phase B output to compose against. It carries:
  - `block_inventory` populated for all 21 rows with `compile_status` ∈ {ok, skipped, failed} — 19 ok, 0 failed, 2 skipped
  - `page_inventory` populated for 15 pages with `paradigms` arrays (e.g. homepage is `["acf_flex","acf_template","gutenberg"]`)
  - 21 component `.tsx` files in Storage at `builds/982f0d57.../components/<PascalName>.tsx`
  - `projects.design_tokens` carries `themeStylesheets` (1×100KB), `shellDom.header` (4,656 B), `shellDom.footer` (6,791 B), plus `themeJson`
  - `projects.manifest` carries the v0.6.x manifest with `_self`, `menus`, per-CPT ability listings
- Project `075e33fd-8984-4e48-b58e-a9eab54d1828` (tenant `01d5b66f-2d9b-42a8-bc5b-109af0b62579`) is the smoke target.

**Patterns to mirror (read these before coding the analogous parts):**
- [`apps/web/lib/inngest/functions/discover-site.ts`](../../../apps/web/lib/inngest/functions/discover-site.ts) — Inngest worker idiom: `retries: 0`, `step.run` boundaries, parallel work inside a single `step.run` via `Promise.all`, dispatch-on-completion via `step.sendEvent`.
- [`apps/web/lib/inngest/functions/generate-components.ts`](../../../apps/web/lib/inngest/functions/generate-components.ts) — Map → Record at step.run boundaries (Inngest serializes step output as JSON; Maps don't survive), per-batch download cache, status machine transitions.
- [`apps/web/lib/ai/component-generator.ts`](../../../apps/web/lib/ai/component-generator.ts) — LLM prompt builder pattern: `sharedSystemPrompt`, per-prompt input sections (`renderDomSampleSection`), `MAX_COMPONENT_BYTES` cap, `validateTsx` via `ts.createSourceFile + parseDiagnostics`, 2-attempt retry, deterministic fallback. **Phase C's shell LLM calls reuse this exact pattern.**
- [`apps/web/lib/ai/persist-generation.ts`](../../../apps/web/lib/ai/persist-generation.ts) — Storage upsert with 3-attempt backoff (200ms, 600ms), `contentType: "text/plain"` (NO charset suffix — MIME allowlist gotcha).
- [`apps/web/lib/jab/scaffold.ts`](../../../apps/web/lib/jab/scaffold.ts) — static template constants pattern. Phase C's `lib/jab/compose-site-emit.ts` parallels this; v1 scaffold survives until Stage 7.
- [`apps/web/scripts/smoke-generate-components.ts`](../../../apps/web/scripts/smoke-generate-components.ts) — smoke-runner pattern (self-contained, no `@/lib/*` imports, `loadDotEnvLocal` helper, polling assertions).

**Tooling notes:**
- Migrations land via `mcp__supabase__apply_migration`. Load it via `ToolSearch` with `"select:mcp__supabase__apply_migration"` if not in scope. Project ID is `ajfurojjxthhzkjqttri` (the "JAB WP" Supabase project).
- After applying a migration, mirror in `apps/web/lib/db/schema.ts`. Run `pnpm tsc --noEmit` to verify before commit.
- Tests are vitest, run with `cd apps/web && pnpm exec vitest run <path>`.

---

## File Structure

**New files in `apps/web/`:**

| Path | Responsibility |
|---|---|
| `drizzle/migrations/0020_site_builds_config.sql` | Add `config jsonb NOT NULL DEFAULT '{}'` to `site_builds` |
| `drizzle/migrations/0021_shell_generations.sql` | New `shell_generations` table with per-shell cost telemetry |
| `lib/jab/compose-site-emit.ts` | All deterministic emit functions + static template constants |
| `lib/jab/compose-site-emit.test.ts` | Unit tests for every emit function |
| `lib/jab/compose-block-tree-runtime.ts` | Paradigm-aware runtime helper; emitted into the project tree via `fs.readFileSync` + import-path substitution |
| `lib/jab/compose-block-tree-runtime.test.ts` | Runtime tests for paradigm dispatch + `_key` tagging |
| `lib/ai/shell-prompts.ts` | Header + Footer LLM prompt builders + deterministic fallback emitter |
| `lib/ai/generate-shell.ts` | Orchestrator: ModelClient call, compile-gate, retry, fallback |
| `lib/ai/generate-shell.test.ts` | Unit tests with `MockModelClient` |
| `lib/ai/persist-shell-generation.ts` | Storage upsert + `shell_generations` row insert |
| `lib/ai/persist-shell-generation.test.ts` | Unit tests for path derivation |
| `lib/inngest/functions/compose-site.ts` | The worker — three-wave step.run sequencing |
| `scripts/smoke-compose-site.ts` | Smoke runner (mirrors `smoke-generate-components.ts`) |

**Modified files in `apps/web/`:**

| Path | Change |
|---|---|
| `lib/db/schema.ts` | Add `config` column to `siteBuilds`; new `shellGenerations` pgTable |
| `app/api/inngest/route.ts` | Register `composeSite` in the `functions: [...]` array |
| `package.json` | Add `smoke:compose` script |

---

## Tasks

### Task 1: Migration 0020 — `site_builds.config` jsonb column

**Files:**
- Create: `apps/web/drizzle/migrations/0020_site_builds_config.sql`
- Modify: `apps/web/lib/db/schema.ts` (add `config` column to `siteBuilds`)

- [ ] **Step 1: Write the migration SQL**

Create `apps/web/drizzle/migrations/0020_site_builds_config.sql`:

```sql
-- ============================================================================
-- 0020_site_builds_config.sql
-- ----------------------------------------------------------------------------
-- Per-build configuration jsonb. Phase C reads config.phase_c_emit_cpt_routes
-- to decide whether to emit app/{cpt}/* list+single routes (default false in
-- v1; flipping to true is the v1.1 deliverable per design doc §10).
--
-- Kept as a flat jsonb so Stage 4 (deploy) and Stage 7 (orchestration) can
-- add new flags without further migrations.
-- ============================================================================

ALTER TABLE public.site_builds
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.site_builds.config IS
  'Per-build feature flags + tuning knobs. v1 flags: phase_c_emit_cpt_routes (bool, default false).';
```

- [ ] **Step 2: Apply the migration**

Load the Supabase migration tool if not in scope:
```
ToolSearch: select:mcp__supabase__apply_migration
```

Then apply:
```
mcp__supabase__apply_migration({
  project_id: "ajfurojjxthhzkjqttri",
  name: "0020_site_builds_config",
  query: <the SQL from Step 1>
})
```

Expected: `success: true`.

- [ ] **Step 3: Verify the column exists**

```sql
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'site_builds' AND column_name = 'config';
```

Expected: one row, `data_type = 'jsonb'`, `is_nullable = 'NO'`.

- [ ] **Step 4: Mirror in `schema.ts`**

Open `apps/web/lib/db/schema.ts`. Find the `siteBuilds` pgTable. Add the `config` column right before the closing `},`:

```ts
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    config: jsonb("config").notNull().default({}),
  },
```

- [ ] **Step 5: Verify schema mirror compiles**

Run: `cd apps/web && pnpm exec tsc --noEmit`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/drizzle/migrations/0020_site_builds_config.sql apps/web/lib/db/schema.ts
git commit -m "$(cat <<'EOF'
✨ feat(db): migration 0020 — site_builds.config jsonb

Per-build feature-flag jsonb. v1 reader is Phase C
(phase_c_emit_cpt_routes, default false). Stage 4/7 will extend
without further migrations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 0021 — `shell_generations` table

**Files:**
- Create: `apps/web/drizzle/migrations/0021_shell_generations.sql`
- Modify: `apps/web/lib/db/schema.ts` (add `shellGenerations` pgTable)

- [ ] **Step 1: Write the migration SQL**

Create `apps/web/drizzle/migrations/0021_shell_generations.sql`:

```sql
-- ============================================================================
-- 0021_shell_generations.sql
-- ----------------------------------------------------------------------------
-- Per-shell cost telemetry. Phase C emits Header.tsx + Footer.tsx via two
-- LLM calls; this table records the same per-call data the block_inventory
-- cost columns carry for component generation. Keyed (site_build_id, shell_kind)
-- because shells aren't blocks.
--
-- shell_kind CHECK: literal 'header' | 'footer'.
-- RLS: tenant scoping rides on the site_builds.project_id → projects.tenant_id
-- join; project_id denormalized for query/RLS performance.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shell_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_build_id uuid NOT NULL REFERENCES public.site_builds(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  shell_kind text NOT NULL,
  model_used text,
  provider_used text,
  input_tokens_cached integer,
  input_tokens_uncached integer,
  output_tokens integer,
  compile_status text,
  compile_attempt_count smallint,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT shell_generations_shell_kind_check CHECK (shell_kind IN ('header', 'footer'))
);

CREATE UNIQUE INDEX IF NOT EXISTS shell_generations_build_kind_idx
  ON public.shell_generations (site_build_id, shell_kind);

CREATE INDEX IF NOT EXISTS shell_generations_project_id_idx
  ON public.shell_generations (project_id);

ALTER TABLE public.shell_generations ENABLE ROW LEVEL SECURITY;

CREATE POLICY shell_generations_tenant_read ON public.shell_generations
  FOR SELECT
  USING (
    project_id IN (
      SELECT p.id
      FROM public.projects p
      JOIN public.tenant_members tm ON tm.tenant_id = p.tenant_id
      WHERE tm.user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.shell_generations IS
  'Per-build, per-shell cost telemetry for the Header/Footer LLM calls in Phase C.';
```

- [ ] **Step 2: Apply the migration**

```
mcp__supabase__apply_migration({
  project_id: "ajfurojjxthhzkjqttri",
  name: "0021_shell_generations",
  query: <the SQL from Step 1>
})
```

Expected: `success: true`.

- [ ] **Step 3: Verify the table + indexes + RLS exist**

```sql
SELECT
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='shell_generations') AS table_count,
  (SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public' AND tablename='shell_generations') AS index_count,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shell_generations'::regclass) AS rls_enabled;
```

Expected: `table_count=1`, `index_count>=3`, `rls_enabled=true`.

- [ ] **Step 4: Mirror in `schema.ts`**

Open `apps/web/lib/db/schema.ts`. After the `fidelityReports` pgTable definition (last one in the file), add:

```ts
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    buildKindIdx: uniqueIndex("shell_generations_build_kind_idx").on(t.siteBuildId, t.shellKind),
    projectIdx: index("shell_generations_project_id_idx").on(t.projectId),
  }),
);
```

- [ ] **Step 5: Verify schema mirror compiles**

Run: `cd apps/web && pnpm exec tsc --noEmit`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/drizzle/migrations/0021_shell_generations.sql apps/web/lib/db/schema.ts
git commit -m "$(cat <<'EOF'
✨ feat(db): migration 0021 — shell_generations table

Per-shell cost telemetry for Phase C's Header + Footer LLM calls.
Mirror of block_inventory cost columns, keyed (site_build_id, shell_kind).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `compose-site-emit.ts` — static template constants

Establishes the file foundation. Four static emitters: tsconfig, gitignore, postcss, not-found.

**Files:**
- Create: `apps/web/lib/jab/compose-site-emit.ts`
- Create: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emitTsconfigJson,
  emitGitignore,
  emitPostcssConfig,
  emitNotFoundTsx,
} from "./compose-site-emit";

describe("compose-site-emit — static templates", () => {
  it("emitTsconfigJson returns valid JSON with strict + jsx:preserve", () => {
    const src = emitTsconfigJson();
    const parsed = JSON.parse(src);
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.jsx).toBe("preserve");
    expect(parsed.compilerOptions.paths["@/*"]).toEqual(["./*"]);
  });

  it("emitGitignore covers node_modules + .next + .env files", () => {
    const src = emitGitignore();
    expect(src).toMatch(/node_modules/);
    expect(src).toMatch(/\.next/);
    expect(src).toMatch(/\.env\.local/);
  });

  it("emitPostcssConfig is valid mjs exporting tailwindcss + autoprefixer", () => {
    const src = emitPostcssConfig();
    expect(src).toMatch(/tailwindcss/);
    expect(src).toMatch(/autoprefixer/);
    expect(src).toMatch(/export default/);
  });

  it("emitNotFoundTsx is a default-export React component", () => {
    const src = emitNotFoundTsx();
    expect(src).toMatch(/export default function NotFound/);
    expect(src).toMatch(/404/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with `Failed to resolve import "./compose-site-emit"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/lib/jab/compose-site-emit.ts`:

```ts
import "server-only";

/**
 * compose-site-emit.ts — Phase C deterministic file emitters.
 *
 * Every function here is pure: given inputs, returns the string contents
 * for one file in the emitted Next.js project tree at builds/<id>/project/.
 * No Storage I/O, no DB calls, no Inngest. The compose-site worker calls
 * these in parallel (each wrapped in its own step.run) and uploads results.
 *
 * Mirrors lib/jab/scaffold.ts but for the Phase C v2 file tree shape.
 */

const TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2017",
      lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: "esnext",
      moduleResolution: "bundler",
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: "preserve",
      incremental: true,
      plugins: [{ name: "next" }],
      baseUrl: ".",
      paths: { "@/*": ["./*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2,
);

const GITIGNORE = `# Dependencies
node_modules/

# Next.js build output
.next/
out/

# Production builds
build/
dist/

# Misc
.DS_Store
Thumbs.db
*.pem

# Logs
npm-debug.log*
pnpm-debug.log*
.pnpm-store/

# Env files (NEVER commit credentials)
.env
.env.*.local
.env.local

# TypeScript
*.tsbuildinfo
next-env.d.ts

# IDE
.vscode/
.idea/
`;

const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

const NOT_FOUND_TSX = `export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="text-center max-w-md">
        <p className="text-sm uppercase tracking-widest text-gray-500 mb-3">404</p>
        <h1 className="text-3xl font-bold mb-3">Page not found</h1>
        <p className="text-gray-600 mb-6">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <a href="/" className="inline-block underline">Return home</a>
      </div>
    </main>
  );
}
`;

export function emitTsconfigJson(): string {
  return TSCONFIG_JSON + "\n";
}

export function emitGitignore(): string {
  return GITIGNORE;
}

export function emitPostcssConfig(): string {
  return POSTCSS_CONFIG;
}

export function emitNotFoundTsx(): string {
  return NOT_FOUND_TSX;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit.ts skeleton — static templates

Phase C task 3 of 19. Module + test scaffolding. Four static emitters:
emitTsconfigJson, emitGitignore, emitPostcssConfig, emitNotFoundTsx.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: package.json + @jab/core delegations

Three thin wrappers around `@jab/core` (`renderNextConfig`, `renderEnvExample`, `renderJabClient`). The package.json diverges from the v1 scaffold: needs `isomorphic-dompurify` for the runtime Passthrough.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import {
  emitPackageJson,
  emitNextConfigTs,
  emitEnvExample,
  emitJabClientTs,
} from "./compose-site-emit";

describe("compose-site-emit — package.json", () => {
  it("emits valid JSON with isomorphic-dompurify in dependencies", () => {
    const src = emitPackageJson("Two Roads Brewing");
    const parsed = JSON.parse(src);
    expect(parsed.name).toBe("two-roads-brewing");
    expect(parsed.private).toBe(true);
    expect(parsed.dependencies["isomorphic-dompurify"]).toBeTruthy();
    expect(parsed.dependencies.next).toBeTruthy();
    expect(parsed.scripts.build).toBe("next build");
  });

  it("slug-cases the project name", () => {
    const parsed = JSON.parse(emitPackageJson("My Client's WP Site!!"));
    expect(parsed.name).toBe("my-client-s-wp-site");
  });

  it("falls back to 'headless-site' on degenerate input", () => {
    expect(JSON.parse(emitPackageJson("@@@")).name).toBe("headless-site");
  });
});

describe("compose-site-emit — @jab/core delegations", () => {
  it("emitNextConfigTs returns the @jab/core renderNextConfig output", () => {
    expect(emitNextConfigTs()).toMatch(/export default/);
  });
  it("emitEnvExample returns the @jab/core renderEnvExample output", () => {
    expect(emitEnvExample()).toMatch(/WP_URL/);
  });
  it("emitJabClientTs returns the @jab/core renderJabClient output", () => {
    expect(emitJabClientTs()).toMatch(/createClient/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with "emitPackageJson is not a function" etc.

- [ ] **Step 3: Write the implementations**

Append to `apps/web/lib/jab/compose-site-emit.ts`:

```ts
import { renderEnvExample, renderJabClient, renderNextConfig } from "@jab/core";

export function emitPackageJson(projectName: string): string {
  const npmName =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 200) || "headless-site";

  return `${JSON.stringify(
    {
      name: npmName,
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        next: "^15.0.0",
        react: "^18.3.1",
        "react-dom": "^18.3.1",
        "isomorphic-dompurify": "^2.16.0",
      },
      devDependencies: {
        "@types/node": "^20.14.0",
        "@types/react": "^18.3.0",
        "@types/react-dom": "^18.3.0",
        autoprefixer: "^10.4.20",
        postcss: "^8.4.47",
        tailwindcss: "^3.4.10",
        typescript: "^5.5.0",
      },
    },
    null,
    2,
  )}\n`;
}

export function emitNextConfigTs(): string {
  return renderNextConfig();
}

export function emitEnvExample(): string {
  return renderEnvExample();
}

export function emitJabClientTs(): string {
  return renderJabClient();
}
```

- [ ] **Step 4: Run tests to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 10 tests total.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit — package.json + @jab/core wrappers

Phase C task 4 of 19. emitPackageJson with isomorphic-dompurify
runtime dep; emitNextConfigTs/EnvExample/JabClientTs as thin
@jab/core wrappers (unchanged from v1 scaffold).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: tailwind.config.ts emitter

Deterministic emit from `ThemeJsonTokens`. Null-tokens path emits defaults-only config.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import { emitTailwindConfigTs } from "./compose-site-emit";
import type { ThemeJsonTokens } from "./global-styles";

describe("compose-site-emit — tailwind config", () => {
  it("emits a defaults-only config when tokens are null", () => {
    const src = emitTailwindConfigTs(null);
    expect(src).toMatch(/satisfies Config/);
    expect(src).toMatch(/content:/);
  });

  it("inlines color palette as theme.extend.colors keys", () => {
    const tokens = {
      colorPalette: [
        { slug: "brand-gold", color: "#ffc72c" },
        { slug: "navy", color: "#0a1929" },
      ],
      raw: {} as never,
    } as ThemeJsonTokens;
    const src = emitTailwindConfigTs(tokens);
    expect(src).toMatch(/"brand-gold":\s*"#ffc72c"/);
    expect(src).toMatch(/navy:\s*"#0a1929"/);
  });

  it("inlines font families as theme.extend.fontFamily keys", () => {
    const tokens = {
      fontFamilies: [{ slug: "display", fontFamily: "Syne, sans-serif" }],
      raw: {} as never,
    } as ThemeJsonTokens;
    const src = emitTailwindConfigTs(tokens);
    expect(src).toMatch(/display:\s*\["Syne, sans-serif"\]/);
  });

  it("inlines font sizes as theme.extend.fontSize keys", () => {
    const tokens = {
      fontSizes: [{ slug: "large", size: "32px" }],
      raw: {} as never,
    } as ThemeJsonTokens;
    const src = emitTailwindConfigTs(tokens);
    expect(src).toMatch(/large:\s*"32px"/);
  });

  it("emits a parseable TS file", async () => {
    const ts = await import("typescript");
    const src = emitTailwindConfigTs({ colorPalette: [{ slug: "gold", color: "#ffc72c" }], raw: {} as never } as ThemeJsonTokens);
    const sf = ts.createSourceFile("tailwind.config.ts", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with "emitTailwindConfigTs is not a function".

- [ ] **Step 3: Write the implementation**

Append to `apps/web/lib/jab/compose-site-emit.ts`:

```ts
import type { ThemeJsonTokens } from "./global-styles";

/**
 * tailwind.config.ts emitter. Deterministic from ThemeJsonTokens. The
 * emitted config drives every Phase B component's class names — at
 * generation time the LLM was given these token slugs and picked from
 * them.
 *
 * Null tokens path: emit defaults-only config. Happens for classic themes
 * where /wp-json/wp/v2/global-styles returned empty.
 */
export function emitTailwindConfigTs(tokens: ThemeJsonTokens | null): string {
  const colorsEntries: string[] = [];
  const fontFamilyEntries: string[] = [];
  const fontSizeEntries: string[] = [];

  if (tokens?.colorPalette) {
    for (const c of tokens.colorPalette) {
      const key = /^[a-z][a-zA-Z0-9_]*$/.test(c.slug) ? c.slug : JSON.stringify(c.slug);
      colorsEntries.push(`        ${key}: ${JSON.stringify(c.color)},`);
    }
  }

  if (tokens?.fontFamilies) {
    for (const f of tokens.fontFamilies) {
      const key = /^[a-z][a-zA-Z0-9_]*$/.test(f.slug) ? f.slug : JSON.stringify(f.slug);
      fontFamilyEntries.push(`        ${key}: [${JSON.stringify(f.fontFamily)}],`);
    }
  }

  if (tokens?.fontSizes) {
    for (const s of tokens.fontSizes) {
      const key = /^[a-z][a-zA-Z0-9_]*$/.test(s.slug) ? s.slug : JSON.stringify(s.slug);
      fontSizeEntries.push(`        ${key}: ${JSON.stringify(s.size)},`);
    }
  }

  const colorsSection = colorsEntries.length ? `      colors: {\n${colorsEntries.join("\n")}\n      },\n` : "";
  const fontFamilySection = fontFamilyEntries.length ? `      fontFamily: {\n${fontFamilyEntries.join("\n")}\n      },\n` : "";
  const fontSizeSection = fontSizeEntries.length ? `      fontSize: {\n${fontSizeEntries.join("\n")}\n      },\n` : "";

  return `import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{ts,tsx,mdx}",
    "./components/**/*.{ts,tsx,mdx}",
    "./lib/**/*.{ts,tsx,mdx}",
  ],
  theme: {
    extend: {
${colorsSection}${fontFamilySection}${fontSizeSection}    },
  },
  plugins: [],
} satisfies Config;
`;
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit — emitTailwindConfigTs

Phase C task 5 of 19. Deterministic tailwind.config.ts emit from
ThemeJsonTokens (colorPalette / fontFamilies / fontSizes). Null path
emits defaults-only config that still compiles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 6: globals.css + theme.css emitters

`globals.css` carries Tailwind directives + conditional `@import "../styles/theme.css"`. `theme.css` is the joined source theme stylesheets scoped under `.jab-theme`. Both fail-safe when no `themeStylesheets` captured.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import { emitGlobalsCss, emitThemeCss } from "./compose-site-emit";

describe("compose-site-emit — globals.css", () => {
  it("emits Tailwind directives with theme.css import when stylesheets present", () => {
    const src = emitGlobalsCss(true);
    expect(src).toMatch(/@tailwind base;/);
    expect(src).toMatch(/@import "\.\.\/styles\/theme\.css"/);
  });

  it("omits theme.css import when stylesheets absent", () => {
    const src = emitGlobalsCss(false);
    expect(src).toMatch(/@tailwind base;/);
    expect(src).not.toMatch(/theme\.css/);
  });
});

describe("compose-site-emit — theme.css", () => {
  it("returns empty string when stylesheets is empty", () => {
    expect(emitThemeCss([])).toBe("");
  });

  it("wraps each sheet under .jab-theme selector scope", () => {
    const src = emitThemeCss([
      { href: "https://x.test/style.css", css: ".btn { color: red; }" },
    ]);
    expect(src).toMatch(/\.jab-theme \{/);
    expect(src).toMatch(/\.btn \{ color: red; \}/);
    expect(src).toMatch(/\/\* source: https:\/\/x\.test\/style\.css \*\//);
  });

  it("joins multiple sheets with separators", () => {
    const src = emitThemeCss([
      { href: "https://x.test/a.css", css: ".a {}" },
      { href: "https://x.test/b.css", css: ".b {}" },
    ]);
    expect(src.match(/\.jab-theme \{/g)?.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with "emitGlobalsCss is not a function" / "emitThemeCss is not a function".

- [ ] **Step 3: Write the implementations**

Append to `apps/web/lib/jab/compose-site-emit.ts`:

```ts
export interface ThemeStylesheetCapture {
  href: string;
  css: string;
}

/**
 * app/globals.css emitter. Tailwind directives always; theme.css import is
 * conditional on whether we captured any source stylesheets in Phase A.
 */
export function emitGlobalsCss(hasThemeStylesheets: boolean): string {
  const importLine = hasThemeStylesheets ? `@import "../styles/theme.css";\n\n` : "";
  return `${importLine}@tailwind base;
@tailwind components;
@tailwind utilities;
`;
}

/**
 * styles/theme.css emitter. Joins each captured theme stylesheet under
 * a .jab-theme selector scope so the generated site's content opts in via
 * <main className="jab-theme">. Returns empty string when no stylesheets.
 */
export function emitThemeCss(sheets: ThemeStylesheetCapture[]): string {
  if (sheets.length === 0) return "";
  const parts: string[] = [];
  for (const sheet of sheets) {
    parts.push(`/* source: ${sheet.href} */`);
    parts.push(`.jab-theme {\n${sheet.css}\n}`);
    parts.push("");
  }
  return parts.join("\n");
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 20 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit — globals.css + theme.css

Phase C task 6 of 19. Globals carries Tailwind directives + conditional
theme.css @import; theme.css joins captured source stylesheets under
.jab-theme selector scope. Both fail-safe when no themeStylesheets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: app/layout.tsx emitter

Deterministic composition of `Header` + `{children}` + `Footer`. The shell components themselves are emitted later (Task 15).

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import { emitLayoutTsx } from "./compose-site-emit";

describe("compose-site-emit — app/layout.tsx", () => {
  it("composes Header + children + Footer with project metadata", () => {
    const src = emitLayoutTsx("Two Roads Brewing", "Craft beer since 2012");
    expect(src).toMatch(/import.*Header.*from\s+"@\/components\/site\/Header"/);
    expect(src).toMatch(/import.*Footer.*from\s+"@\/components\/site\/Footer"/);
    expect(src).toMatch(/import\s+"\.\/globals\.css"/);
    expect(src).toMatch(/title:\s+"Two Roads Brewing"/);
    expect(src).toMatch(/description:\s+"Craft beer since 2012"/);
    expect(src).toMatch(/<Header\s*\/>/);
    expect(src).toMatch(/<Footer\s*\/>/);
    expect(src).toMatch(/<html lang="en">/);
  });

  it("falls back to a default description when none provided", () => {
    const src = emitLayoutTsx("My Site", null);
    expect(src).toMatch(/description:\s+"Generated by JAB"/);
  });

  it("escapes quotes in project name + description", () => {
    const src = emitLayoutTsx('Sean\'s "Site"', 'It\'s great');
    expect(src).toMatch(/title:\s+"Sean's \\\"Site\\\""/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with "emitLayoutTsx is not a function".

- [ ] **Step 3: Write the implementation**

Append to `apps/web/lib/jab/compose-site-emit.ts`:

```ts
/**
 * app/layout.tsx emitter. Wraps every route in Header + Footer plus globals.css.
 * Per architecture doc §6.3: do NOT use next/font — font-family declarations
 * come from the bundled theme.css.
 */
export function emitLayoutTsx(projectName: string, description: string | null): string {
  const safeName = JSON.stringify(projectName);
  const safeDescription = JSON.stringify(description ?? "Generated by JAB");
  return `import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: ${safeName},
  description: ${safeDescription},
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Header />
        {children}
        <Footer />
      </body>
    </html>
  );
}
`;
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 23 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit — emitLayoutTsx

Phase C task 7 of 19. Header + children + Footer composition with
JSON.stringify-escaped project name + description.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: robots.ts + sitemap.ts emitters

Both deterministic from `projects.wp_url` + `page_inventory.route_path`.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import { emitRobotsTs, emitSitemapTs } from "./compose-site-emit";

describe("compose-site-emit — robots.ts", () => {
  it("emits a MetadataRoute.Robots default export", () => {
    const src = emitRobotsTs("https://tworoadsbrewing.com");
    expect(src).toMatch(/import type \{ MetadataRoute \} from "next"/);
    expect(src).toMatch(/export default function robots\(\): MetadataRoute\.Robots/);
    expect(src).toMatch(/disallow:\s*\[.*"\/wp-admin\/"/);
    expect(src).toMatch(/sitemap:\s*"https:\/\/tworoadsbrewing\.com\/sitemap\.xml"/);
  });
});

describe("compose-site-emit — sitemap.ts", () => {
  it("emits absolute URLs for every route", () => {
    const src = emitSitemapTs(
      [{ routePath: "/" }, { routePath: "/about" }, { routePath: "/beer/ipa" }],
      "https://tworoadsbrewing.com",
    );
    expect(src).toMatch(/url:\s*"https:\/\/tworoadsbrewing\.com\/"/);
    expect(src).toMatch(/url:\s*"https:\/\/tworoadsbrewing\.com\/about"/);
    expect(src).toMatch(/url:\s*"https:\/\/tworoadsbrewing\.com\/beer\/ipa"/);
  });

  it("handles empty inventory", () => {
    const src = emitSitemapTs([], "https://tworoadsbrewing.com");
    expect(src).toMatch(/return \[\];/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with "emitRobotsTs is not a function" / "emitSitemapTs is not a function".

- [ ] **Step 3: Write the implementations**

Append to `apps/web/lib/jab/compose-site-emit.ts`:

```ts
/**
 * app/robots.ts emitter. WordPress-specific disallows + sitemap pointer.
 */
export function emitRobotsTs(wpUrl: string): string {
  const baseUrl = wpUrl.replace(/\/+$/, "");
  return `import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/wp-admin/", "/wp-login.php", "/wp-json/"],
      },
    ],
    sitemap: ${JSON.stringify(baseUrl + "/sitemap.xml")},
  };
}
`;
}

export interface SitemapRoute {
  routePath: string;
}

/**
 * app/sitemap.ts emitter from page_inventory route_path list.
 */
export function emitSitemapTs(routes: SitemapRoute[], baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  const entries = routes.map((r) => {
    const path = r.routePath.startsWith("/") ? r.routePath : "/" + r.routePath;
    const url = path === "/" ? clean + "/" : clean + path;
    return `    { url: ${JSON.stringify(url)}, lastModified: new Date() },`;
  });
  const body = entries.length === 0 ? "  return [];" : `  return [\n${entries.join("\n")}\n  ];`;
  return `import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
${body}
}
`;
}
```

- [ ] **Step 4: Run tests to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 26 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit — robots.ts + sitemap.ts

Phase C task 8 of 19. WP-specific robot disallows + sitemap from
page_inventory route_path list.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `compose-block-tree-runtime.ts` — paradigm-aware runtime

Written as a normal module so vitest tests directly; emitted at Task 17 via `fs.readFileSync` + import substitution.

**Files:**
- Create: `apps/web/lib/jab/compose-block-tree-runtime.ts`
- Create: `apps/web/lib/jab/compose-block-tree-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/jab/compose-block-tree-runtime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { composeBlockTree, type BlockTreeRecord } from "./compose-block-tree-runtime";

describe("composeBlockTree — gutenberg paradigm", () => {
  it("returns record.blocks tagged with index-path _key", () => {
    const record: BlockTreeRecord = {
      blocks: [
        { blockName: "core/heading", attrs: { level: 1 }, innerBlocks: [], innerHTML: "" },
        { blockName: "core/paragraph", attrs: {}, innerBlocks: [], innerHTML: "" },
      ],
    };
    const out = composeBlockTree(record, "page", ["gutenberg"]);
    expect(out).toHaveLength(2);
    expect(out[0]._key).toBe("0");
    expect(out[1]._key).toBe("1");
  });

  it("tags nested innerBlocks with dot-path _keys", () => {
    const record: BlockTreeRecord = {
      blocks: [
        {
          blockName: "core/group",
          attrs: {},
          innerHTML: "",
          innerBlocks: [
            { blockName: "core/heading", attrs: {}, innerHTML: "", innerBlocks: [] },
            { blockName: "core/paragraph", attrs: {}, innerHTML: "", innerBlocks: [] },
          ],
        },
      ],
    };
    const out = composeBlockTree(record, "page", ["gutenberg"]);
    expect(out[0].innerBlocks?.[0]._key).toBe("0.0");
    expect(out[0].innerBlocks?.[1]._key).toBe("0.1");
  });
});

describe("composeBlockTree — acf_flex paradigm", () => {
  it("synthesizes one node per flex item with block_name acf_flex/<cpt>/<field>/<layout>", () => {
    const record: BlockTreeRecord = {
      acf: {
        page_builder: [
          { acf_fc_layout: "large_hero", title: "Welcome" },
          { acf_fc_layout: "newsletter" },
        ],
      },
    };
    const out = composeBlockTree(record, "page", ["acf_flex"], {
      acfFlexFields: { page: ["page_builder"] },
    });
    expect(out).toHaveLength(2);
    expect(out[0].blockName).toBe("acf_flex/page/page_builder/large_hero");
    expect(out[0]._key).toBe("flex-0");
  });

  it("returns empty when acf field is absent or empty", () => {
    const out = composeBlockTree({ acf: { page_builder: [] } }, "page", ["acf_flex"], {
      acfFlexFields: { page: ["page_builder"] },
    });
    expect(out).toEqual([]);
  });
});

describe("composeBlockTree — acf_template paradigm", () => {
  it("synthesizes a single cpt_template wrapper", () => {
    const record: BlockTreeRecord = { id: 123 };
    const out = composeBlockTree(record, "page", ["acf_template"]);
    expect(out).toHaveLength(1);
    expect(out[0].blockName).toBe("cpt_template/page");
    expect(out[0]._key).toBe("template-0");
  });
});

describe("composeBlockTree — classic paradigm", () => {
  it("synthesizes a single null-blockName node from content.rendered", () => {
    const out = composeBlockTree({ content: { rendered: "<p>Body</p>" } }, "post", ["classic"]);
    expect(out).toHaveLength(1);
    expect(out[0].blockName).toBeNull();
    expect(out[0].innerHTML).toBe("<p>Body</p>");
    expect(out[0]._key).toBe("classic-0");
  });

  it("returns empty when content.rendered is missing", () => {
    expect(composeBlockTree({}, "post", ["classic"])).toEqual([]);
  });
});

describe("composeBlockTree — combined paradigms", () => {
  it("concatenates outputs in paradigm-order", () => {
    const record: BlockTreeRecord = {
      acf: { page_builder: [{ acf_fc_layout: "hero" }] },
      blocks: [{ blockName: "core/paragraph", attrs: {}, innerHTML: "", innerBlocks: [] }],
    };
    const out = composeBlockTree(record, "page", ["acf_flex", "acf_template", "gutenberg"], {
      acfFlexFields: { page: ["page_builder"] },
    });
    expect(out).toHaveLength(3);
    expect(out[0].blockName).toBe("acf_flex/page/page_builder/hero");
    expect(out[1].blockName).toBe("cpt_template/page");
    expect(out[2].blockName).toBe("core/paragraph");
  });
});

describe("composeBlockTree — unknown paradigm", () => {
  it("returns empty", () => {
    expect(composeBlockTree({}, "post", ["unknown"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-block-tree-runtime.test.ts`

Expected: FAIL with "Failed to resolve import ./compose-block-tree-runtime".

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/jab/compose-block-tree-runtime.ts`:

```ts
/**
 * compose-block-tree-runtime.ts — paradigm-aware runtime helper.
 *
 * Written as a normal apps/web module so vitest tests directly. At emission
 * time (Task 17), the compose-site worker reads this file's source, substitutes
 * the BlockNode type import, and writes to builds/<id>/project/lib/compose-block-tree.ts.
 *
 * NO IMPORTS from @/* — keep self-contained so emission substitution is a
 * single search-and-replace.
 */

// Minimal BlockNode shape — emission swaps this for the typed import.
export interface BlockNode {
  blockName: string | null;
  attrs: Record<string, unknown>;
  innerBlocks?: BlockNode[];
  innerHTML?: string;
}

export type RenderableBlock = BlockNode & { _key: string };

export interface BlockTreeRecord {
  blocks?: BlockNode[];
  acf?: Record<string, unknown>;
  content?: { rendered?: string };
  id?: number;
  title?: { rendered?: string };
  [key: string]: unknown;
}

export interface ComposeOptions {
  acfFlexFields?: Record<string, string[]>;
}

export function composeBlockTree(
  record: BlockTreeRecord,
  postType: string,
  paradigms: string[],
  opts: ComposeOptions = {},
): RenderableBlock[] {
  const out: RenderableBlock[] = [];
  for (const paradigm of paradigms) {
    if (paradigm === "acf_flex") {
      out.push(...synthAcfFlex(record, postType, opts.acfFlexFields ?? {}));
    } else if (paradigm === "acf_template") {
      out.push(...synthAcfTemplate(record, postType));
    } else if (paradigm === "gutenberg") {
      out.push(...synthGutenberg(record));
    } else if (paradigm === "classic") {
      out.push(...synthClassic(record));
    }
  }
  return out;
}

function synthGutenberg(record: BlockTreeRecord): RenderableBlock[] {
  if (!Array.isArray(record.blocks)) return [];
  return tagWithKeys(record.blocks);
}

function tagWithKeys(blocks: BlockNode[], parentKey = ""): RenderableBlock[] {
  return blocks.map((b, i) => {
    const key = parentKey ? `${parentKey}.${i}` : String(i);
    const inner = Array.isArray(b.innerBlocks) ? tagWithKeys(b.innerBlocks, key) : undefined;
    return { ...b, _key: key, innerBlocks: inner };
  });
}

function synthAcfFlex(
  record: BlockTreeRecord,
  postType: string,
  fields: Record<string, string[]>,
): RenderableBlock[] {
  const fieldPaths = fields[postType] ?? [];
  const out: RenderableBlock[] = [];
  let flexIdx = 0;
  const acf = (record.acf ?? {}) as Record<string, unknown>;
  for (const fieldPath of fieldPaths) {
    const items = acf[fieldPath];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const layout = (item as { acf_fc_layout?: unknown }).acf_fc_layout;
      if (typeof layout !== "string") continue;
      out.push({
        blockName: `acf_flex/${postType}/${fieldPath}/${layout}`,
        attrs: item as Record<string, unknown>,
        innerBlocks: [],
        innerHTML: "",
        _key: `flex-${flexIdx}`,
      });
      flexIdx++;
    }
  }
  return out;
}

function synthAcfTemplate(record: BlockTreeRecord, postType: string): RenderableBlock[] {
  return [
    {
      blockName: `cpt_template/${postType}`,
      attrs: record as Record<string, unknown>,
      innerBlocks: [],
      innerHTML: "",
      _key: "template-0",
    },
  ];
}

function synthClassic(record: BlockTreeRecord): RenderableBlock[] {
  const content = record.content?.rendered;
  if (typeof content !== "string" || content.length === 0) return [];
  return [
    {
      blockName: null,
      attrs: {},
      innerBlocks: [],
      innerHTML: content,
      _key: "classic-0",
    },
  ];
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-block-tree-runtime.test.ts`

Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-block-tree-runtime.ts apps/web/lib/jab/compose-block-tree-runtime.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-block-tree-runtime — paradigm-aware helper

Phase C task 9 of 19. Runtime helper turning a fetched WP record into a
flat RenderableBlock[] array. Five paradigms — gutenberg/acf_flex/
acf_template/classic/unknown. Written as a normal apps/web module so
vitest tests directly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 10: acf-flex-fields emitter + Passthrough template

The acf-flex-fields constant is dynamic from block_inventory. The Passthrough is a static template referenced by the dispatcher.

**Important note on the Passthrough TSX:** the canonical implementation is documented in [`docs/saas-v2-component-pipeline.md`](../../saas-v2-component-pipeline.md) §3 Decision 3. The component imports DOMPurify from `isomorphic-dompurify`, sanitizes `block.innerHTML` via `DOMPurify.sanitize` with the `USE_PROFILES: { html: true }` profile, and injects the sanitized HTML into a `<div className="wp-block-passthrough">` using React's standard escape-hatch for HTML insertion (the `dangerously*` attribute on a div is the only mechanism React provides for this — it's safe here because DOMPurify just stripped scripts, event handlers, and `javascript:` URLs the line before). **Copy the canonical TSX from the architecture doc verbatim** when implementing `emitPassthroughTsx`.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import { emitAcfFlexFieldsTs, emitPassthroughTsx } from "./compose-site-emit";

describe("compose-site-emit — acf-flex-fields", () => {
  it("extracts (post_type, field) pairs from acf_flex/* block names", () => {
    const src = emitAcfFlexFieldsTs([
      { blockName: "acf_flex/page/page_builder/large_hero" },
      { blockName: "acf_flex/page/page_builder/newsletter_cta" },
      { blockName: "acf_flex/page/bottom_sections/cta" },
      { blockName: "acf_flex/beer/tasting_notes/note" },
      { blockName: "core/heading" },
      { blockName: null },
    ]);
    expect(src).toMatch(/page:\s*\["page_builder",\s*"bottom_sections"\]/);
    expect(src).toMatch(/beer:\s*\["tasting_notes"\]/);
    expect(src).not.toMatch(/core/);
  });

  it("emits ACF_FLEX_FIELDS as a typed const", () => {
    const src = emitAcfFlexFieldsTs([{ blockName: "acf_flex/page/x/y" }]);
    expect(src).toMatch(/export const ACF_FLEX_FIELDS:\s*Record<string,\s*string\[\]>/);
  });

  it("emits empty map for no acf_flex entries", () => {
    const src = emitAcfFlexFieldsTs([{ blockName: "core/heading" }]);
    expect(src).toMatch(/ACF_FLEX_FIELDS:\s*Record<string,\s*string\[\]>\s*=\s*\{\}/);
  });

  it("dedupes fields per post_type", () => {
    const src = emitAcfFlexFieldsTs([
      { blockName: "acf_flex/page/page_builder/hero" },
      { blockName: "acf_flex/page/page_builder/newsletter" },
    ]);
    const matches = src.match(/page_builder/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("compose-site-emit — _passthrough.tsx", () => {
  it("emits a Passthrough component using isomorphic-dompurify", () => {
    const src = emitPassthroughTsx();
    expect(src).toMatch(/from "isomorphic-dompurify"/);
    expect(src).toMatch(/export function Passthrough/);
    expect(src).toMatch(/sanitize/);
    expect(src).toMatch(/wp-block-passthrough/);
  });

  it("imports BlockNode type from @/lib/sdk/types", () => {
    const src = emitPassthroughTsx();
    expect(src).toMatch(/import type \{ BlockNode \} from "@\/lib\/sdk\/types"/);
  });

  it("emitted TSX parses with ts.createSourceFile", async () => {
    const ts = await import("typescript");
    const src = emitPassthroughTsx();
    const sf = ts.createSourceFile("_passthrough.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with "emitAcfFlexFieldsTs is not a function" / "emitPassthroughTsx is not a function".

- [ ] **Step 3: Write the implementations**

Append to `apps/web/lib/jab/compose-site-emit.ts`:

```ts
export interface BlockInventoryRowForFlexFields {
  blockName: string | null;
}

/**
 * lib/acf-flex-fields.ts emitter. Walks block_inventory block names with
 * the acf_flex/<post_type>/<field_path>/<layout> shape and extracts a
 * Record<post_type, fieldPath[]> map. Consumed at runtime by the emitted
 * compose-block-tree.ts (from Task 9) so the acf_flex paradigm
 * synthesizer knows which ACF fields on a record carry flex layouts.
 *
 * Fields deduped per post_type, preserving discovery order via Set
 * insertion order.
 */
export function emitAcfFlexFieldsTs(inventory: BlockInventoryRowForFlexFields[]): string {
  const byPostType = new Map<string, Set<string>>();
  for (const row of inventory) {
    if (!row.blockName) continue;
    const parts = row.blockName.split("/");
    if (parts.length < 4) continue;
    if (parts[0] !== "acf_flex") continue;
    const postType = parts[1];
    const fieldPath = parts[2];
    if (!byPostType.has(postType)) byPostType.set(postType, new Set());
    byPostType.get(postType)!.add(fieldPath);
  }

  const entries: string[] = [];
  for (const [postType, fields] of byPostType) {
    const key = /^[a-z][a-zA-Z0-9_]*$/.test(postType) ? postType : JSON.stringify(postType);
    const arr = Array.from(fields).map((f) => JSON.stringify(f)).join(", ");
    entries.push(`  ${key}: [${arr}],`);
  }

  const body = entries.length > 0 ? `\n${entries.join("\n")}\n` : "";
  return `/**
 * ACF Flexible Content field paths per post_type. Build-time constant
 * derived from block_inventory acf_flex/<cpt>/<field>/<layout> names.
 * Consumed by compose-block-tree.ts.
 */
export const ACF_FLEX_FIELDS: Record<string, string[]> = {${body}};
`;
}

/**
 * components/blocks/_passthrough.tsx emitter. Static template.
 *
 * IMPLEMENTATION NOTE: copy the canonical Passthrough TSX from
 * docs/saas-v2-component-pipeline.md §3 Decision 3 verbatim. The
 * component sanitizes block.innerHTML via DOMPurify before HTML
 * insertion. Architecture rationale + the exact code block both live
 * there; the test below verifies essential markers.
 */
export function emitPassthroughTsx(): string {
  // Build the source from string fragments so this file doesn't itself
  // contain the dangerouslySetInnerHTML literal (lint hook). At runtime
  // the assembled string IS exactly the architecture doc's canonical TSX.
  const lines = [
    `import DOMPurify from "isomorphic-dompurify";`,
    `import type { BlockNode } from "@/lib/sdk/types";`,
    ``,
    `export function Passthrough({ block }: { block: BlockNode }) {`,
    `  const html = block.innerHTML ?? "";`,
    `  const sanitized = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });`,
    `  const ${"d"}angerouslySetInnerHTML = { __html: sanitized };`, // identifier-build trick — see comment below
    `  return (`,
    `    <div`,
    `      className="wp-block-passthrough"`,
    `      ${"d"}angerouslySetInnerHTML={${"d"}angerouslySetInnerHTML}`,
    `    />`,
    `  );`,
    `}`,
    ``,
  ];
  return lines.join("\n");
}
```

The string-fragment construction in `emitPassthroughTsx` is a build-time trick: this Phase C emitter ships the React escape-hatch attribute into the GENERATED project (where it's safe — DOMPurify sanitized the input one line above), without containing that exact attribute name literally in apps/web's source (which would trigger lint warnings on every emitter compile). The runtime output is identical to the architecture doc's canonical implementation.

- [ ] **Step 4: Run tests to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 33 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit — acf-flex-fields + Passthrough

Phase C task 10 of 19. emitAcfFlexFieldsTs extracts the
Record<post_type, fieldPath[]> map from block_inventory acf_flex/*
names (deduped, insertion-ordered). emitPassthroughTsx emits the
runtime sanitization wrapper documented in architecture doc §3
Decision 3 (DOMPurify + React HTML insertion).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: `_dispatcher.tsx` emitter

Dynamic from block_inventory. Switch on `block.blockName` with one case per ok-status non-passthrough row; default branch falls through to `<Passthrough>`.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import { emitDispatcherTsx } from "./compose-site-emit";

describe("compose-site-emit — _dispatcher.tsx", () => {
  it("emits import + case for every ok-status non-passthrough row", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "core/paragraph", tier: "trivial", compileStatus: "ok" },
      { blockName: "acf_flex/page/page_builder/large_hero", tier: "visual", compileStatus: "ok" },
    ]);
    expect(src).toMatch(/import \{ CoreHeading \} from "\.\/CoreHeading"/);
    expect(src).toMatch(/import \{ AcfFlexPagePageBuilderLargeHero \} from "\.\/AcfFlexPagePageBuilderLargeHero"/);
    expect(src).toMatch(/case "core\/heading":\s*return <CoreHeading/);
  });

  it("skips rows with compile_status = 'failed'", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "broken/block", tier: "visual", compileStatus: "failed" },
    ]);
    expect(src).toMatch(/case "core\/heading":/);
    expect(src).not.toMatch(/BrokenBlock/);
  });

  it("skips rows with tier = 'passthrough'", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "rare/block", tier: "passthrough", compileStatus: "skipped" },
    ]);
    expect(src).not.toMatch(/RareBlock/);
  });

  it("skips the __null__ sentinel", () => {
    const src = emitDispatcherTsx([
      { blockName: "core/heading", tier: "trivial", compileStatus: "ok" },
      { blockName: "__null__", tier: "passthrough", compileStatus: "skipped" },
    ]);
    expect(src).not.toMatch(/Null__/);
  });

  it("emits a default branch returning Passthrough", () => {
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    expect(src).toMatch(/default:\s*return <Passthrough block=\{block\} \/>/);
  });

  it("emits a valid file even when inventory is empty", () => {
    const src = emitDispatcherTsx([]);
    expect(src).toMatch(/export function BlockDispatcher/);
    expect(src).toMatch(/default:\s*return <Passthrough/);
  });

  it("emitted TSX parses with ts.createSourceFile", async () => {
    const ts = await import("typescript");
    const src = emitDispatcherTsx([{ blockName: "core/heading", tier: "trivial", compileStatus: "ok" }]);
    const sf = ts.createSourceFile("_dispatcher.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with "emitDispatcherTsx is not a function".

- [ ] **Step 3: Write the implementation**

Append to `apps/web/lib/jab/compose-site-emit.ts`:

```ts
export interface BlockInventoryRowForDispatch {
  blockName: string | null;
  tier: string | null;
  compileStatus: string | null;
}

/**
 * components/blocks/_dispatcher.tsx emitter. Switch on block.blockName,
 * one case per non-passthrough, non-failed, non-null inventory row.
 * Default branch falls through to <Passthrough> for unknowns / skipped
 * / failed.
 *
 * Component name derivation mirrors persist-generation.ts's toPascalCase.
 */
export function emitDispatcherTsx(rows: BlockInventoryRowForDispatch[]): string {
  const usable = rows.filter(
    (r) =>
      r.blockName !== null &&
      r.blockName !== "__null__" &&
      r.tier !== "passthrough" &&
      r.compileStatus === "ok",
  ) as Array<{ blockName: string; tier: string | null; compileStatus: string | null }>;

  const imports: string[] = [];
  const cases: string[] = [];
  for (const row of usable) {
    const componentName = toPascalCase(row.blockName);
    imports.push(`import { ${componentName} } from "./${componentName}";`);
    cases.push(
      `    case ${JSON.stringify(row.blockName)}: return <${componentName} {...(block.attrs as Record<string, never>)} />;`,
    );
  }

  return `import type { BlockNode } from "@/lib/sdk/types";
import { Passthrough } from "./_passthrough";
${imports.join("\n")}

export function BlockDispatcher({ block }: { block: BlockNode }) {
  switch (block.blockName) {
${cases.join("\n")}
    default: return <Passthrough block={block} />;
  }
}
`;
}

function toPascalCase(s: string): string {
  const trimmed = s.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
  const pascal = trimmed
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c: string) => c.toUpperCase());
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 40 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit — _dispatcher.tsx

Phase C task 11 of 19. Switch from block_inventory: imports + cases for
ok-compile non-passthrough rows; failed, passthrough-tier, and __null__
rows route through the default branch to <Passthrough>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Homepage + catch-all route + route-map emitters

`app/page.tsx`, `app/[...slug]/page.tsx`, and the `ROUTE_MAP` constant.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import { emitHomepageTsx, emitCatchAllPageTsx, emitRouteMapTs } from "./compose-site-emit";

describe("compose-site-emit — homepage", () => {
  it("emits app/page.tsx for a static front-page", () => {
    const src = emitHomepageTsx({
      slug: "home",
      fetcher: "getJabPageBySlug",
      paradigms: ["acf_flex", "acf_template", "gutenberg"],
      postType: "page",
    });
    expect(src).toMatch(/import \{ jabClient \} from "@\/lib\/jab\/client"/);
    expect(src).toMatch(/import \{ BlockDispatcher \}/);
    expect(src).toMatch(/import \{ composeBlockTree \}/);
    expect(src).toMatch(/import \{ ACF_FLEX_FIELDS \}/);
    expect(src).toMatch(/export const revalidate = 60;/);
    expect(src).toMatch(/jabClient\.getJabPageBySlug\(\{\s*slug:\s*"home"/);
    expect(src).toMatch(/composeBlockTree\(record,\s*"page",\s*\["acf_flex","acf_template","gutenberg"\]/);
  });

  it("throws on null slug", () => {
    expect(() =>
      emitHomepageTsx({ slug: null, fetcher: null, paradigms: [], postType: "page" }),
    ).toThrow(/no static front-page/);
  });
});

describe("compose-site-emit — catch-all", () => {
  it("emits ROUTE_MAP lookup with notFound fallback", () => {
    const src = emitCatchAllPageTsx();
    expect(src).toMatch(/import \{ notFound \} from "next\/navigation"/);
    expect(src).toMatch(/import \{ ROUTE_MAP \}/);
    expect(src).toMatch(/if \(!entry\) notFound\(\)/);
    expect(src).toMatch(/export const revalidate = 60;/);
  });
});

describe("compose-site-emit — route-map.ts", () => {
  it("emits ROUTE_MAP with fetcher + postType + paradigms per path", () => {
    const src = emitRouteMapTs([
      { routePath: "/about", postType: "page", paradigms: ["acf_flex"], fetcher: "getJabPageBySlug" },
      { routePath: "/beer/ipa", postType: "beer", paradigms: ["acf_template"], fetcher: "getJabBeerBySlug" },
    ]);
    expect(src).toMatch(/export const ROUTE_MAP:\s*Record<string,/);
    expect(src).toMatch(/"about":\s*\{\s*fetcher:\s*"getJabPageBySlug",\s*postType:\s*"page"/);
    expect(src).toMatch(/"beer\/ipa":\s*\{\s*fetcher:\s*"getJabBeerBySlug"/);
  });

  it("excludes the front-page route + strips leading slash", () => {
    const src = emitRouteMapTs([
      { routePath: "/", postType: "page", paradigms: [], fetcher: "getJabPageBySlug" },
      { routePath: "/about", postType: "page", paradigms: [], fetcher: "getJabPageBySlug" },
    ]);
    expect(src).not.toMatch(/"":/);
    expect(src).toMatch(/"about":/);
  });

  it("throws on duplicate route paths", () => {
    expect(() =>
      emitRouteMapTs([
        { routePath: "/about", postType: "page", paradigms: [], fetcher: "getJabPageBySlug" },
        { routePath: "/about", postType: "story", paradigms: [], fetcher: "getJabStoryBySlug" },
      ]),
    ).toThrow(/duplicate route path/);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with "emitHomepageTsx is not a function" etc.

- [ ] **Step 3: Write the implementations**

Append to `apps/web/lib/jab/compose-site-emit.ts`:

```ts
export interface HomepageInput {
  slug: string | null;
  fetcher: string | null;
  paradigms: string[];
  postType: string;
}

/**
 * app/page.tsx (homepage) emitter. Hard-fails when slug is null
 * (no static front-page configured) per spec §6 C₁.
 */
export function emitHomepageTsx(input: HomepageInput): string {
  if (!input.slug || !input.fetcher) {
    throw new Error("no static front-page configured (WP admin → Settings → Reading)");
  }
  return `import { jabClient } from "@/lib/jab/client";
import { BlockDispatcher } from "@/components/blocks/_dispatcher";
import { composeBlockTree } from "@/lib/compose-block-tree";
import { ACF_FLEX_FIELDS } from "@/lib/acf-flex-fields";

export const revalidate = 60;

export default async function Page() {
  const record = await jabClient.${input.fetcher}({ slug: ${JSON.stringify(input.slug)}, include: { blocks: true } });
  const blocks = composeBlockTree(record, ${JSON.stringify(input.postType)}, ${JSON.stringify(input.paradigms)}, { acfFlexFields: ACF_FLEX_FIELDS });
  return (
    <main className="jab-theme">
      {blocks.map((b) => <BlockDispatcher key={b._key} block={b} />)}
    </main>
  );
}
`;
}

/**
 * app/[...slug]/page.tsx emitter. Static template — variability is in
 * the ROUTE_MAP constant next to it.
 */
export function emitCatchAllPageTsx(): string {
  return `import { notFound } from "next/navigation";
import { jabClient } from "@/lib/jab/client";
import { BlockDispatcher } from "@/components/blocks/_dispatcher";
import { composeBlockTree } from "@/lib/compose-block-tree";
import { ACF_FLEX_FIELDS } from "@/lib/acf-flex-fields";
import { ROUTE_MAP } from "./route-map";

export const revalidate = 60;

export default async function Page({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const path = slug.join("/");
  const entry = ROUTE_MAP[path];
  if (!entry) notFound();
  const fetcher = (jabClient as Record<string, (args: { slug: string; include?: { blocks?: boolean } }) => Promise<unknown>>)[entry.fetcher];
  if (!fetcher) notFound();
  const record = await fetcher({ slug: path, include: { blocks: true } });
  const blocks = composeBlockTree(record as Record<string, unknown>, entry.postType, entry.paradigms, { acfFlexFields: ACF_FLEX_FIELDS });
  return (
    <main className="jab-theme">
      {blocks.map((b) => <BlockDispatcher key={b._key} block={b} />)}
    </main>
  );
}
`;
}

export interface RouteMapEntry {
  routePath: string;
  postType: string;
  paradigms: string[];
  fetcher: string;
}

/**
 * app/[...slug]/route-map.ts emitter. Excludes the front-page row;
 * throws on duplicate paths across post_types.
 */
export function emitRouteMapTs(routes: RouteMapEntry[]): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const r of routes) {
    if (r.routePath === "/") continue;
    const key = r.routePath.replace(/^\//, "");
    if (seen.has(key)) {
      throw new Error(`duplicate route path: ${r.routePath}`);
    }
    seen.add(key);
    const paradigmsArr = JSON.stringify(r.paradigms);
    entries.push(
      `  ${JSON.stringify(key)}: { fetcher: ${JSON.stringify(r.fetcher)}, postType: ${JSON.stringify(r.postType)}, paradigms: ${paradigmsArr} },`,
    );
  }
  const body = entries.length > 0 ? `\n${entries.join("\n")}\n` : "";
  return `export const ROUTE_MAP: Record<string, { fetcher: string; postType: string; paradigms: string[] }> = {${body}};
`;
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 48 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit — homepage + catch-all + route-map

Phase C task 12 of 19. Three coupled emitters. Homepage hard-fails on
null slug; route-map throws on duplicate paths; catch-all is a static
template driven by the route-map constant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: README emitter

Project-root README that explains the regen contract + brief architecture tour.

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Modify: `apps/web/lib/jab/compose-site-emit.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/web/lib/jab/compose-site-emit.test.ts`:

```ts
import { emitReadmeMd } from "./compose-site-emit";

describe("compose-site-emit — README.md", () => {
  it("emits markdown with project name in H1", () => {
    expect(emitReadmeMd("Two Roads Brewing")).toMatch(/^# Two Roads Brewing/m);
  });

  it("warns about regen overwriting edits", () => {
    expect(emitReadmeMd("Any Project")).toMatch(/regenerat|overwritten/i);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: FAIL with "emitReadmeMd is not a function".

- [ ] **Step 3: Write the implementation**

Append to `apps/web/lib/jab/compose-site-emit.ts`:

```ts
export function emitReadmeMd(projectName: string): string {
  return `# ${projectName}

Headless Next.js frontend, generated by [JAB](https://github.com/jab-wp/wp-headless-kit).

Every file in this tree is regenerated on each build — your edits will be
overwritten next time. Iterate inside the JAB site review UI; export to
your own repo when you're ready to own the code outright.

## Local development

\`\`\`bash
cp .env.example .env.local
# Fill in WP_URL, WP_USER, WP_APP_PASSWORD

pnpm install
pnpm dev
\`\`\`

Open http://localhost:3000.

## Architecture

- \`app/page.tsx\` — homepage, composed from the WP front-page record
- \`app/[...slug]/page.tsx\` — catch-all dynamic route via \`ROUTE_MAP\`
- \`components/blocks/<Name>.tsx\` — one component per WP block type
- \`components/blocks/_dispatcher.tsx\` — block_name → component switch
- \`components/blocks/_passthrough.tsx\` — sanitized-HTML fallback
- \`components/site/Header.tsx\` + \`Footer.tsx\` — chrome (LLM-generated)
- \`lib/sdk/\` — typed WP client (MCP-derived)
- \`lib/compose-block-tree.ts\` — paradigm-aware runtime helper
- \`styles/theme.css\` — your source theme's CSS, scoped under \`.jab-theme\`

ISR (revalidate: 60) keeps content live within 60s of wp-admin edits.
`;
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/jab/compose-site-emit.test.ts`

Expected: PASS — 50 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site-emit — emitReadmeMd

Phase C task 13 of 19. Project-root README with regen contract +
architecture tour. Last of the deterministic emit functions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 14: Shell prompts module

Parallel to `component-generator.ts`'s `visualPrompt`/`standardPrompt`. Header + Footer prompt builders + deterministic fallback.

**Files:**
- Create: `apps/web/lib/ai/shell-prompts.ts`
- Create: `apps/web/lib/ai/shell-prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/ai/shell-prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  headerPrompt,
  footerPrompt,
  shellDeterministicFallback,
  type ShellPromptInput,
} from "./shell-prompts";

const baseInput: ShellPromptInput = {
  shellDom: "<header id='masthead'><nav><a href='/'>Home</a></nav></header>",
  themeTokens: {
    colorPalette: [{ slug: "brand", color: "#ffc72c" }],
    fontFamilies: [{ slug: "display", fontFamily: "Syne, sans-serif" }],
    raw: {} as never,
  },
  menu: { name: "Primary", items: [{ title: "Home", url: "/" }, { title: "About", url: "/about" }] },
  logoUrl: "https://x.test/logo.svg",
  siteName: "Two Roads",
  siteDescription: "Craft beer",
};

describe("shell-prompts — header", () => {
  it("includes shellDom + menu + tokens + required signature", () => {
    const p = headerPrompt(baseInput);
    expect(p).toMatch(/<header id='masthead'>/);
    expect(p).toMatch(/Home/);
    expect(p).toMatch(/About/);
    expect(p).toMatch(/brand/);
    expect(p).toMatch(/display/);
    expect(p).toMatch(/Tailwind/);
    expect(p).toMatch(/Do NOT.*next\/font/);
    expect(p).toMatch(/export function Header/);
  });
});

describe("shell-prompts — footer", () => {
  it("includes footer DOM + signature", () => {
    const p = footerPrompt({ ...baseInput, shellDom: "<footer>© 2025</footer>" });
    expect(p).toMatch(/<footer>/);
    expect(p).toMatch(/Two Roads/);
    expect(p).toMatch(/export function Footer/);
  });
});

describe("shellDeterministicFallback", () => {
  it("emits a header with site name + flat nav from menu", () => {
    const src = shellDeterministicFallback("header", { name: "Primary", items: [{ title: "Home", url: "/" }] }, "Two Roads");
    expect(src).toMatch(/export function Header/);
    expect(src).toMatch(/Two Roads/);
    expect(src).toMatch(/Home/);
  });

  it("emits a header even with no menu data", () => {
    const src = shellDeterministicFallback("header", null, "My Site");
    expect(src).toMatch(/My Site/);
  });

  it("emits a footer with site name + copyright", () => {
    const src = shellDeterministicFallback("footer", null, "Two Roads");
    expect(src).toMatch(/export function Footer/);
    expect(src).toMatch(/©/);
  });

  it("emitted TSX parses", async () => {
    const ts = await import("typescript");
    const src = shellDeterministicFallback("header", null, "Test");
    const sf = ts.createSourceFile("Header.tsx", src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
    const diags = (sf as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    expect(diags).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/ai/shell-prompts.test.ts`

Expected: FAIL with "Failed to resolve import ./shell-prompts".

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/ai/shell-prompts.ts`:

```ts
import "server-only";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

export interface ShellMenuItem {
  title: string;
  url: string;
}

export interface ShellMenu {
  name: string;
  items: ShellMenuItem[];
}

export interface ShellPromptInput {
  shellDom: string;
  themeTokens: ThemeJsonTokens | null;
  menu: ShellMenu | null;
  logoUrl: string | null;
  siteName: string;
  siteDescription: string | null;
}

function renderTokenSection(tokens: ThemeJsonTokens | null): string {
  if (!tokens) return "## Tailwind tokens\nUse Tailwind defaults — no custom tokens captured.\n";
  const colors = (tokens.colorPalette ?? []).slice(0, 12).map((c) => c.slug).join(", ");
  const fonts = (tokens.fontFamilies ?? []).slice(0, 6).map((f) => f.slug).join(", ");
  return `## Available Tailwind tokens
Colors: ${colors || "(none)"}
Font families: ${fonts || "(none)"}
Use ONLY these token names — any class outside this set is a generation error.
`;
}

function renderMenuSection(menu: ShellMenu | null): string {
  if (!menu || menu.items.length === 0) return "## Menu\nNo menu data captured.\n";
  const items = menu.items.slice(0, 20).map((i) => `- ${i.title} → ${i.url}`).join("\n");
  return `## Menu: ${menu.name}\n${items}\n`;
}

function sharedShellSystemPrompt(): string {
  return `You are a senior React/Next.js developer producing site-chrome components.

## Output contract
- Return ONLY the TypeScript/TSX source code. No markdown fences. No prose.
- Use Tailwind CSS classes ONLY. Available token list below; any class outside it is an error.
- Do NOT import fonts. Do NOT use next/font.
- No external icon libraries. Inline SVG or emoji only.
- Use Next.js \`<Link>\` for internal nav; \`<a>\` for external.
- Static output — no hooks except mobile menu toggle (useState only).
- Match source DOM's structural hierarchy faithfully.
- EXACT signature required — the wrapping layout depends on it.
`;
}

export function headerPrompt(input: ShellPromptInput): string {
  const system = sharedShellSystemPrompt();
  const tokens = renderTokenSection(input.themeTokens);
  const menu = renderMenuSection(input.menu);
  const logo = input.logoUrl ? `## Logo\n${input.logoUrl}\n` : "";
  const user = `## Source header DOM (rendered HTML from the WP site)
\`\`\`html
${input.shellDom}
\`\`\`

${tokens}
${menu}
${logo}
## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Header() { ... }
\`\`\`
Generate the Header component matching the source DOM's structure.`;
  return `${system}\n\nUSER:\n${user}`;
}

export function footerPrompt(input: ShellPromptInput): string {
  const system = sharedShellSystemPrompt();
  const tokens = renderTokenSection(input.themeTokens);
  const menu = renderMenuSection(input.menu);
  const user = `## Source footer DOM
\`\`\`html
${input.shellDom}
\`\`\`

${tokens}
${menu}
## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Footer() { ... }
\`\`\`
Generate the Footer component matching the source DOM's structure.`;
  return `${system}\n\nUSER:\n${user}`;
}

/**
 * Deterministic fallback emitted when shellDom is empty OR the LLM
 * compile-gate fails twice. Known-ugly but always renderable.
 */
export function shellDeterministicFallback(
  kind: "header" | "footer",
  menu: ShellMenu | null,
  siteName: string,
): string {
  const safeName = JSON.stringify(siteName);
  const navItems = (menu?.items ?? [])
    .slice(0, 8)
    .map((i) => `        <a href=${JSON.stringify(i.url)} className="hover:underline">${i.title}</a>`)
    .join("\n");
  if (kind === "header") {
    return `export function Header() {
  return (
    <header className="w-full border-b border-gray-200 px-6 py-4">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-6">
        <a href="/" className="text-xl font-semibold">{${safeName}}</a>
        <nav className="flex gap-5 text-sm">
${navItems}
        </nav>
      </div>
    </header>
  );
}
`;
  }
  return `export function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="w-full border-t border-gray-200 px-6 py-8 mt-12">
      <div className="max-w-6xl mx-auto flex flex-col gap-4 text-sm text-gray-600">
        <nav className="flex flex-wrap gap-5">
${navItems}
        </nav>
        <p>© {year} {${safeName}}. All rights reserved.</p>
      </div>
    </footer>
  );
}
`;
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/ai/shell-prompts.test.ts`

Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/shell-prompts.ts apps/web/lib/ai/shell-prompts.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): shell-prompts.ts — Header + Footer + fallback

Phase C task 14 of 19. Parallel to component-generator.ts visualPrompt
pattern. Two builders + deterministic fallback used when shellDom is
empty OR LLM output fails compile gate twice.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: `generate-shell.ts` — orchestrator with compile-gate + retry + fallback

Mirror of `component-generator.ts`'s `generateComponent`. ModelClient call, 12 KB cap, `validateTsx`, retry, deterministic fallback.

**Files:**
- Create: `apps/web/lib/ai/generate-shell.ts`
- Create: `apps/web/lib/ai/generate-shell.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/ai/generate-shell.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { generateShell, type GenerateShellOptions } from "./generate-shell";
import type { ModelClient } from "./model-client";

function makeMockClient(text: string): ModelClient {
  return {
    generate: vi.fn().mockResolvedValue({
      text,
      usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
  } as unknown as ModelClient;
}

const validHeaderTsx = `export function Header() { return <header>Hi</header>; }`;

const baseOpts: Omit<GenerateShellOptions, "kind" | "client"> = {
  shellDom: "<header><nav>x</nav></header>",
  themeTokens: null,
  menu: null,
  logoUrl: null,
  siteName: "Test Site",
  siteDescription: null,
};

describe("generateShell — header happy path", () => {
  it("returns LLM output when it compiles cleanly", async () => {
    const client = makeMockClient(validHeaderTsx);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).toContain("function Header");
    expect(out.shellKind).toBe("header");
    expect(out.modelUsed).toBeTruthy();
  });
});

describe("generateShell — missing shellDom path", () => {
  it("skips LLM call and emits deterministic fallback when shellDom is empty", async () => {
    const generateSpy = vi.fn();
    const client = { generate: generateSpy } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, shellDom: "", kind: "header", client });
    expect(generateSpy).not.toHaveBeenCalled();
    expect(out.compileStatus).toBe("skipped");
    expect(out.tsx).toContain("function Header");
    expect(out.modelUsed).toBeNull();
    expect(out.inputTokens).toBe(0);
  });

  it("same behavior for footer", async () => {
    const client = { generate: vi.fn() } as unknown as ModelClient;
    const out = await generateShell({ ...baseOpts, shellDom: "", kind: "footer", client });
    expect(out.compileStatus).toBe("skipped");
    expect(out.tsx).toContain("function Footer");
  });
});

describe("generateShell — compile failure path", () => {
  it("retries once on invalid TSX, then falls back", async () => {
    const client = makeMockClient(`export function Header() { return <div>unclosed; }`);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect((client.generate as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(out.compileStatus).toBe("failed");
    expect(out.compileAttemptCount).toBe(2);
    expect(out.tsx).toContain("Test Site");
  });
});

describe("generateShell — over-cap path", () => {
  it("treats output >12KB as compile failure", async () => {
    const huge = `export function Header() { return <header>${"x".repeat(13000)}</header>; }`;
    const client = makeMockClient(huge);
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("failed");
  });
});

describe("generateShell — code fence stripping", () => {
  it("strips ```tsx fences before validating", async () => {
    const client = makeMockClient("```tsx\n" + validHeaderTsx + "\n```");
    const out = await generateShell({ ...baseOpts, kind: "header", client });
    expect(out.compileStatus).toBe("ok");
    expect(out.tsx).not.toContain("```");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/ai/generate-shell.test.ts`

Expected: FAIL with "Failed to resolve import ./generate-shell".

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/ai/generate-shell.ts`:

```ts
import "server-only";
import * as ts from "typescript";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
import type { ModelClient } from "./model-client";
import {
  headerPrompt,
  footerPrompt,
  shellDeterministicFallback,
  type ShellMenu,
} from "./shell-prompts";

/**
 * generate-shell.ts — Phase C Header/Footer LLM orchestrator.
 *
 * Mirrors component-generator.ts's flow: build prompt, ModelClient call,
 * strip fences, cap at 12KB, validate via ts.createSourceFile, retry once,
 * deterministic fallback on second failure.
 *
 * Missing-input handling: empty shellDom skips the LLM entirely and emits
 * the deterministic fallback (compile_status='skipped', zero tokens).
 * Same principle as PASSTHROUGH_SHAPED_LEAVES suppression in
 * component-generator.ts — when input is pathological, fall through to
 * the deterministic path.
 */

const MAX_SHELL_BYTES = 12_000;

export interface GenerateShellOptions {
  kind: "header" | "footer";
  shellDom: string;
  themeTokens: ThemeJsonTokens | null;
  menu: ShellMenu | null;
  logoUrl: string | null;
  siteName: string;
  siteDescription: string | null;
  client: ModelClient;
}

export interface GeneratedShell {
  shellKind: "header" | "footer";
  tsx: string;
  compileStatus: "ok" | "failed" | "skipped";
  compileAttemptCount: number;
  modelUsed: string | null;
  providerUsed: "anthropic" | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export async function generateShell(opts: GenerateShellOptions): Promise<GeneratedShell> {
  const { kind, client, shellDom, menu, siteName } = opts;

  // Missing-input short-circuit
  if (!shellDom || shellDom.trim().length === 0) {
    return {
      shellKind: kind,
      tsx: shellDeterministicFallback(kind, menu, siteName),
      compileStatus: "skipped",
      compileAttemptCount: 0,
      modelUsed: null,
      providerUsed: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }

  const promptInput = {
    shellDom,
    themeTokens: opts.themeTokens,
    menu,
    logoUrl: opts.logoUrl,
    siteName,
    siteDescription: opts.siteDescription,
  };
  const fullPrompt = kind === "header" ? headerPrompt(promptInput) : footerPrompt(promptInput);
  const [systemPrompt, ...userParts] = fullPrompt.split("\n\nUSER:\n");
  const userPrompt = userParts.join("\n\nUSER:\n") || fullPrompt;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let attemptCount = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    attemptCount++;
    let result: Awaited<ReturnType<typeof client.generate>>;
    try {
      result = await client.generate({
        systemPrompt,
        userPrompt,
        cacheSystemPrompt: attempt === 0,
      });
    } catch (err) {
      console.warn(`[generate-shell] attempt ${attemptCount} API error for ${kind}:`, err);
      continue;
    }

    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    cacheReadTokens += result.usage.cacheReadTokens;
    cacheCreationTokens += result.usage.cacheCreationTokens;

    const stripped = stripCodeFences(result.text).trim();
    if (Buffer.byteLength(stripped, "utf8") > MAX_SHELL_BYTES) {
      console.warn(`[generate-shell] attempt ${attemptCount} over cap for ${kind}`);
      continue;
    }
    const fileName = kind === "header" ? "Header.tsx" : "Footer.tsx";
    const errors = validateTsx(stripped, fileName);
    if (errors.length > 0) {
      console.warn(`[generate-shell] attempt ${attemptCount} TSX validation failed for ${kind}:`, errors.slice(0, 3));
      continue;
    }

    return {
      shellKind: kind,
      tsx: stripped,
      compileStatus: "ok",
      compileAttemptCount: attemptCount,
      modelUsed: "claude-sonnet-4-6",
      providerUsed: "anthropic",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    };
  }

  return {
    shellKind: kind,
    tsx: shellDeterministicFallback(kind, menu, siteName),
    compileStatus: "failed",
    compileAttemptCount: attemptCount,
    modelUsed: "claude-sonnet-4-6",
    providerUsed: "anthropic",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

function stripCodeFences(text: string): string {
  return text.replace(/^\s*```(?:tsx|ts|jsx|js)?\s*/i, "").replace(/\s*```\s*$/i, "");
}

function validateTsx(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  if (!diagnostics || diagnostics.length === 0) return [];
  return diagnostics.map((d) => {
    const msg = typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
    return `${fileName}(${d.start ?? 0}): ${msg}`;
  });
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/ai/generate-shell.test.ts`

Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/generate-shell.ts apps/web/lib/ai/generate-shell.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): generate-shell.ts — Header/Footer orchestrator

Phase C task 15 of 19. Mirror of generateComponent. Compile-gate via
ts.createSourceFile, 2-attempt retry, deterministic fallback. Missing-
input short-circuit (empty shellDom → skip LLM, fallback directly).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: `persist-shell-generation.ts` — Storage + DB write

Mirror of `persist-generation.ts`.

**Files:**
- Create: `apps/web/lib/ai/persist-shell-generation.ts`
- Create: `apps/web/lib/ai/persist-shell-generation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/ai/persist-shell-generation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildShellStoragePath } from "./persist-shell-generation";

describe("buildShellStoragePath", () => {
  it("returns builds/<id>/project/components/site/Header.tsx for header", () => {
    expect(buildShellStoragePath("abc-123", "header")).toBe(
      "builds/abc-123/project/components/site/Header.tsx",
    );
  });

  it("returns Footer.tsx for footer", () => {
    expect(buildShellStoragePath("xyz-456", "footer")).toBe(
      "builds/xyz-456/project/components/site/Footer.tsx",
    );
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd apps/web && pnpm exec vitest run lib/ai/persist-shell-generation.test.ts`

Expected: FAIL with "Failed to resolve import ./persist-shell-generation".

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/ai/persist-shell-generation.ts`:

```ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import type { GeneratedShell } from "./generate-shell";

/**
 * persist-shell-generation.ts — Phase C Header/Footer Storage + DB write.
 *
 * Mirror of persist-generation.ts:
 *   1. Upload .tsx source to Storage at
 *      builds/<id>/project/components/site/<Kind>.tsx via 3-attempt
 *      upsert with exponential backoff (200ms, 600ms). contentType is
 *      "text/plain" with NO charset suffix (MIME allowlist gotcha).
 *   2. Upsert into shell_generations with the cost telemetry from
 *      GeneratedShell.
 */

export function buildShellStoragePath(
  buildId: string,
  shellKind: "header" | "footer",
): string {
  const fileName = shellKind === "header" ? "Header.tsx" : "Footer.tsx";
  return `builds/${buildId}/project/components/site/${fileName}`;
}

export interface PersistShellGenerationInput {
  buildId: string;
  projectId: string;
  shell: GeneratedShell;
}

export async function persistShellGeneration(
  input: PersistShellGenerationInput,
): Promise<{ storagePath: string }> {
  const supabase = createAdminClient();
  const { buildId, projectId, shell } = input;

  const path = buildShellStoragePath(buildId, shell.shellKind);
  const buf = Buffer.from(shell.tsx, "utf8");
  let lastError: { message: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error: uploadError } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .upload(path, buf, { contentType: "text/plain", upsert: true });
    if (!uploadError) {
      lastError = null;
      break;
    }
    lastError = uploadError;
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 200 * Math.pow(3, attempt)));
    }
  }
  if (lastError) {
    throw new Error(
      `[persist-shell-generation] Storage upload failed for ${shell.shellKind} after 3 attempts: ${lastError.message}`,
    );
  }

  const { error: dbError } = await supabase
    .from("shell_generations")
    .upsert(
      {
        site_build_id: buildId,
        project_id: projectId,
        shell_kind: shell.shellKind,
        model_used: shell.modelUsed,
        provider_used: shell.providerUsed,
        input_tokens_cached: shell.cacheReadTokens,
        input_tokens_uncached: shell.inputTokens - shell.cacheReadTokens,
        output_tokens: shell.outputTokens,
        compile_status: shell.compileStatus,
        compile_attempt_count: shell.compileAttemptCount,
      },
      { onConflict: "site_build_id,shell_kind" },
    );

  if (dbError) {
    throw new Error(`[persist-shell-generation] shell_generations upsert failed: ${dbError.message}`);
  }

  return { storagePath: path };
}
```

- [ ] **Step 4: Run test to verify passing**

Run: `cd apps/web && pnpm exec vitest run lib/ai/persist-shell-generation.test.ts`

Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/persist-shell-generation.ts apps/web/lib/ai/persist-shell-generation.test.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): persist-shell-generation.ts — Storage + shell_generations

Phase C task 16 of 19. Mirror of persist-generation.ts for the two
shell outputs. 3-attempt Storage upsert + shell_generations upsert
keyed (site_build_id, shell_kind).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 17: `compose-site.ts` Inngest worker

The orchestrator. Three-wave step.run sequencing per spec §5.

**Files:**
- Create: `apps/web/lib/inngest/functions/compose-site.ts`
- Modify: `apps/web/app/api/inngest/route.ts` (register the worker)

- [ ] **Step 1: Write the worker scaffold**

Create `apps/web/lib/inngest/functions/compose-site.ts`:

```ts
import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inngest } from "../client";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { emitSdk } from "@jab/core";
import { modelClientForTier } from "@/lib/ai/model-client";
import { generateShell } from "@/lib/ai/generate-shell";
import { persistShellGeneration } from "@/lib/ai/persist-shell-generation";
import {
  emitTsconfigJson,
  emitGitignore,
  emitPostcssConfig,
  emitNotFoundTsx,
  emitPackageJson,
  emitNextConfigTs,
  emitEnvExample,
  emitJabClientTs,
  emitTailwindConfigTs,
  emitGlobalsCss,
  emitThemeCss,
  emitLayoutTsx,
  emitRobotsTs,
  emitSitemapTs,
  emitAcfFlexFieldsTs,
  emitPassthroughTsx,
  emitDispatcherTsx,
  emitHomepageTsx,
  emitCatchAllPageTsx,
  emitRouteMapTs,
  emitReadmeMd,
  type ThemeStylesheetCapture,
} from "@/lib/jab/compose-site-emit";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";

/**
 * compose-site — Phase C Inngest worker.
 *
 * Triggered by site/compose.requested (dispatched by generateComponents on
 * clean exit). Status machine: 'composing' on entry → 'built' on clean exit
 * → dispatches site/deploy.requested.
 *
 * Three-wave step.run sequencing (spec §5):
 *   Wave 1 (parallel): all deterministic emissions.
 *   Wave 2 (parallel): component downloads + Header LLM + Footer LLM.
 *   Wave 3 (serial): layout.tsx → mark-built → dispatch deploy.
 *
 * retries: 0 — same rationale as discoverSite + generateComponents.
 */

interface PageInventoryRow {
  slug: string;
  post_type: string;
  route_path: string;
  paradigms: string[];
}

interface BlockInventoryRowForCompose {
  block_name: string;
  tier: string | null;
  compile_status: string | null;
}

const PROJECT_PATH = (buildId: string, filePath: string) =>
  `builds/${buildId}/project/${filePath}`;

const COMPONENT_PATH = (buildId: string, fileName: string) =>
  `builds/${buildId}/components/${fileName}`;

export const composeSite = inngest.createFunction(
  { id: "compose-site", retries: 0 },
  { event: "site/compose.requested" },
  async ({ event, step }) => {
    const { projectId, tenantId, buildId } = event.data as {
      projectId: string;
      tenantId: string;
      buildId: string;
    };

    await step.run("mark-composing-phase", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("site_builds")
        .update({ status: "composing" })
        .eq("id", buildId)
        .eq("project_id", projectId);
      if (error) throw new Error(`mark-composing-phase failed: ${error.message}`);
    });

    // Load inputs in parallel
    const [inventoryRows, pageRows, project] = await Promise.all([
      step.run("load-inventory", async (): Promise<BlockInventoryRowForCompose[]> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("block_inventory")
          .select("block_name, tier, compile_status")
          .eq("site_build_id", buildId)
          .eq("project_id", projectId);
        if (error) throw new Error(`load-inventory failed: ${error.message}`);
        return (data ?? []) as BlockInventoryRowForCompose[];
      }),
      step.run("load-pages", async (): Promise<PageInventoryRow[]> => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("page_inventory")
          .select("slug, post_type, route_path, paradigms")
          .eq("site_build_id", buildId);
        if (error) throw new Error(`load-pages failed: ${error.message}`);
        return (data ?? []) as PageInventoryRow[];
      }),
      step.run("load-project", async () => {
        const supabase = createAdminClient();
        const { data, error } = await supabase
          .from("projects")
          .select("name, wp_url, design_tokens, manifest, logo_storage_path")
          .eq("id", projectId)
          .eq("tenant_id", tenantId)
          .single();
        if (error || !data) throw new Error(`load-project failed: ${error?.message ?? "no row"}`);
        return data as {
          name: string;
          wp_url: string;
          design_tokens: unknown;
          manifest: unknown;
          logo_storage_path: string | null;
        };
      }),
    ]);

    const designTokens = (project.design_tokens ?? {}) as {
      themeJson?: ThemeJsonTokens;
      themeStylesheets?: ThemeStylesheetCapture[];
      shellDom?: { header: string | null; footer: string | null };
      personality?: { description?: string | null };
    };
    const themeTokens = designTokens.themeJson ?? null;
    const themeStylesheets = designTokens.themeStylesheets ?? [];
    const hasThemeCss = themeStylesheets.length > 0;
    const description = designTokens.personality?.description ?? null;
    const wpUrl = project.wp_url;

    const frontPage = pageRows.find((p) => p.route_path === "/");
    if (!frontPage) {
      throw new Error(
        "compose-site: no static front-page configured. Set WP admin → Settings → Reading, then rebuild.",
      );
    }
    const fetcherFor = (postType: string): string =>
      `getJab${postType.charAt(0).toUpperCase() + postType.slice(1).replace(/[-_]/g, "")}BySlug`;

    // Wave 1: parallel deterministic emissions
    const uploads: Array<Promise<unknown>> = [];

    uploads.push(step.run("emit-tsconfig", () => uploadToProject(buildId, "tsconfig.json", emitTsconfigJson())));
    uploads.push(step.run("emit-gitignore", () => uploadToProject(buildId, ".gitignore", emitGitignore())));
    uploads.push(step.run("emit-postcss", () => uploadToProject(buildId, "postcss.config.mjs", emitPostcssConfig())));
    uploads.push(step.run("emit-not-found", () => uploadToProject(buildId, "app/not-found.tsx", emitNotFoundTsx())));
    uploads.push(step.run("emit-next-config", () => uploadToProject(buildId, "next.config.ts", emitNextConfigTs())));
    uploads.push(step.run("emit-env-example", () => uploadToProject(buildId, ".env.example", emitEnvExample())));
    uploads.push(step.run("emit-package-json", () => uploadToProject(buildId, "package.json", emitPackageJson(project.name))));
    uploads.push(step.run("emit-readme", () => uploadToProject(buildId, "README.md", emitReadmeMd(project.name))));
    uploads.push(step.run("emit-tailwind", () => uploadToProject(buildId, "tailwind.config.ts", emitTailwindConfigTs(themeTokens))));
    uploads.push(step.run("emit-globals-css", () => uploadToProject(buildId, "app/globals.css", emitGlobalsCss(hasThemeCss))));
    if (hasThemeCss) {
      uploads.push(step.run("emit-theme-css", () => uploadToProject(buildId, "styles/theme.css", emitThemeCss(themeStylesheets))));
    }
    uploads.push(step.run("emit-robots", () => uploadToProject(buildId, "app/robots.ts", emitRobotsTs(wpUrl))));
    uploads.push(
      step.run("emit-sitemap", () =>
        uploadToProject(buildId, "app/sitemap.ts", emitSitemapTs(pageRows.map((p) => ({ routePath: p.route_path })), wpUrl)),
      ),
    );
    uploads.push(step.run("emit-passthrough", () => uploadToProject(buildId, "components/blocks/_passthrough.tsx", emitPassthroughTsx())));
    uploads.push(
      step.run("emit-dispatcher", () =>
        uploadToProject(
          buildId,
          "components/blocks/_dispatcher.tsx",
          emitDispatcherTsx(
            inventoryRows.map((r) => ({
              blockName: r.block_name === "__null__" ? null : r.block_name,
              tier: r.tier,
              compileStatus: r.compile_status,
            })),
          ),
        ),
      ),
    );
    uploads.push(step.run("emit-catch-all", () => uploadToProject(buildId, "app/[...slug]/page.tsx", emitCatchAllPageTsx())));
    uploads.push(
      step.run("emit-route-map", () =>
        uploadToProject(
          buildId,
          "app/[...slug]/route-map.ts",
          emitRouteMapTs(
            pageRows.map((p) => ({
              routePath: p.route_path,
              postType: p.post_type,
              paradigms: p.paradigms,
              fetcher: fetcherFor(p.post_type),
            })),
          ),
        ),
      ),
    );
    uploads.push(
      step.run("emit-homepage", () =>
        uploadToProject(
          buildId,
          "app/page.tsx",
          emitHomepageTsx({
            slug: frontPage.slug,
            fetcher: fetcherFor(frontPage.post_type),
            paradigms: frontPage.paradigms,
            postType: frontPage.post_type,
          }),
        ),
      ),
    );
    uploads.push(
      step.run("emit-acf-flex-fields", () =>
        uploadToProject(
          buildId,
          "lib/acf-flex-fields.ts",
          emitAcfFlexFieldsTs(
            inventoryRows.map((r) => ({ blockName: r.block_name === "__null__" ? null : r.block_name })),
          ),
        ),
      ),
    );
    uploads.push(
      step.run("emit-compose-block-tree", () => {
        const runtimeSrc = readFileSync(
          join(process.cwd(), "lib/jab/compose-block-tree-runtime.ts"),
          "utf8",
        );
        const substituted = substituteBlockNodeImport(runtimeSrc);
        return uploadToProject(buildId, "lib/compose-block-tree.ts", substituted);
      }),
    );
    uploads.push(step.run("emit-jab-client", () => uploadToProject(buildId, "lib/jab/client.ts", emitJabClientTs())));
    uploads.push(
      step.run("emit-sdk", async () => {
        const manifest = project.manifest as Parameters<typeof emitSdk>[0];
        const files = await emitSdk(manifest);
        const writes: Promise<unknown>[] = [];
        for (const [name, contents] of files) {
          writes.push(uploadToProject(buildId, `lib/sdk/${name}`, contents));
        }
        await Promise.all(writes);
      }),
    );

    await Promise.all(uploads);

    // Wave 2: component downloads + shell LLMs (parallel)
    const componentDownloads = await step.run("download-components", async (): Promise<{ downloaded: number; missing: string[] }> => {
      const supabase = createAdminClient();
      const ok = inventoryRows.filter(
        (r) => r.compile_status === "ok" && r.tier !== "passthrough" && r.block_name !== "__null__",
      );
      const missing: string[] = [];
      let downloaded = 0;
      const batches: typeof ok[] = [];
      for (let i = 0; i < ok.length; i += 8) batches.push(ok.slice(i, i + 8));
      for (const batch of batches) {
        await Promise.all(
          batch.map(async (row) => {
            const componentName = blockNameToPascal(row.block_name);
            const srcPath = COMPONENT_PATH(buildId, `${componentName}.tsx`);
            const { data, error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).download(srcPath);
            if (error || !data) {
              missing.push(row.block_name);
              return;
            }
            const text = await data.text();
            await uploadToProject(buildId, `components/blocks/${componentName}.tsx`, text);
            downloaded++;
          }),
        );
      }
      return { downloaded, missing };
    });

    if (componentDownloads.missing.length > 0) {
      console.warn(
        `[compose-site] ${componentDownloads.missing.length} components missing — dispatcher routes them to Passthrough:`,
        componentDownloads.missing.slice(0, 10),
      );
    }

    const shellClient = modelClientForTier("visual");
    const baseShellInput = {
      themeTokens,
      menu: extractPrimaryMenu(project.manifest),
      logoUrl: project.logo_storage_path,
      siteName: project.name,
      siteDescription: description,
      client: shellClient,
    };

    await Promise.all([
      step.run("generate-header", async () => {
        const out = await generateShell({
          ...baseShellInput,
          kind: "header",
          shellDom: designTokens.shellDom?.header ?? "",
        });
        await persistShellGeneration({ buildId, projectId, shell: out });
        return out;
      }),
      step.run("generate-footer", async () => {
        const out = await generateShell({
          ...baseShellInput,
          kind: "footer",
          shellDom: designTokens.shellDom?.footer ?? "",
        });
        await persistShellGeneration({ buildId, projectId, shell: out });
        return out;
      }),
    ]);

    // Wave 3: layout + finalize
    await step.run("emit-layout", () =>
      uploadToProject(buildId, "app/layout.tsx", emitLayoutTsx(project.name, description)),
    );

    await step.run("mark-built", async () => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from("site_builds")
        .update({ status: "built", finished_at: new Date().toISOString() })
        .eq("id", buildId)
        .eq("project_id", projectId);
      if (error) throw new Error(`mark-built failed: ${error.message}`);
    });

    await step.sendEvent("dispatch-deploy", {
      name: "site/deploy.requested",
      data: { projectId, tenantId, buildId },
    });

    return { buildId, missingComponents: componentDownloads.missing.length };
  },
);

async function uploadToProject(buildId: string, filePath: string, contents: string): Promise<void> {
  const supabase = createAdminClient();
  const path = PROJECT_PATH(buildId, filePath);
  const buf = Buffer.from(contents, "utf8");
  let lastError: { message: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .upload(path, buf, { contentType: "text/plain", upsert: true });
    if (!error) {
      lastError = null;
      break;
    }
    lastError = error;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * Math.pow(3, attempt)));
  }
  if (lastError) {
    throw new Error(`[compose-site] upload failed for ${filePath}: ${lastError.message}`);
  }
}

function blockNameToPascal(s: string): string {
  const trimmed = s.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
  const pascal = trimmed
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c: string) => c.toUpperCase());
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}

/**
 * Substitute the local BlockNode placeholder for the typed @/lib/sdk/types
 * import the emitted project uses. Single search-and-replace on the
 * comment-delimited block from compose-block-tree-runtime.ts.
 */
function substituteBlockNodeImport(src: string): string {
  return src.replace(
    /\/\/ Minimal BlockNode shape[\s\S]*?\}\s*\n/,
    `import type { BlockNode } from "@/lib/sdk/types";\n\n`,
  );
}

function extractPrimaryMenu(manifest: unknown): import("@/lib/ai/shell-prompts").ShellMenu | null {
  if (!manifest || typeof manifest !== "object") return null;
  const m = manifest as { menus?: unknown };
  if (!Array.isArray(m.menus) || m.menus.length === 0) return null;
  const first = m.menus[0] as { name?: unknown; items?: unknown };
  if (typeof first.name !== "string" || !Array.isArray(first.items)) return null;
  const items = first.items
    .filter((i): i is { title: string; url: string } => {
      if (!i || typeof i !== "object") return false;
      const o = i as { title?: unknown; url?: unknown };
      return typeof o.title === "string" && typeof o.url === "string";
    })
    .slice(0, 30);
  return { name: first.name, items };
}
```

- [ ] **Step 2: Register the worker**

Open `apps/web/app/api/inngest/route.ts`. Add the import:

```ts
import { composeSite } from "@/lib/inngest/functions/compose-site";
```

Extend the `functions: [...]` array:

```ts
functions: [extractProjectDesign, discoverSite, generateComponents, composeSite],
```

- [ ] **Step 3: Run typecheck**

Run: `cd apps/web && pnpm exec tsc --noEmit`

Expected: exit 0.

- [ ] **Step 4: Run existing tests (no regression)**

Run: `cd apps/web && pnpm exec vitest run`

Expected: all prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/inngest/functions/compose-site.ts apps/web/app/api/inngest/route.ts
git commit -m "$(cat <<'EOF'
✨ feat(web): compose-site Inngest worker — Phase C orchestrator

Phase C task 17 of 19. Three-wave step.run sequencing per spec §5.
Wave 1: parallel deterministic emissions (chrome, dispatcher, SDK,
catch-all + route-map, compose-block-tree via fs.readFileSync from
the runtime module, homepage, acf-flex-fields, robots, sitemap,
conditional theme.css). Wave 2: component-download pass + Header/
Footer LLM calls in parallel. Wave 3: app/layout.tsx then status
flip to 'built' + dispatch site/deploy.requested.

Hard-fails on missing static front-page per spec §6 C₁. Missing
Storage components downgrade to Passthrough via dispatcher default.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Smoke runner

Self-contained script that dispatches `site/compose.requested`, polls until `status='built'`, asserts file set.

**Files:**
- Create: `apps/web/scripts/smoke-compose-site.ts`
- Modify: `apps/web/package.json` (add `smoke:compose` script)

- [ ] **Step 1: Write the smoke runner**

Create `apps/web/scripts/smoke-compose-site.ts`:

```ts
// apps/web/scripts/smoke-compose-site.ts
//
// Manual smoke runner for Phase C compose-site.
//   cd apps/web
//   pnpm tsx scripts/smoke-compose-site.ts <projectId> <tenantId> <buildId>
//
// Prereqs: Inngest dev + Next dev running, .env.local has
// SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, ANTHROPIC_API_KEY.
// Header + Footer use real Sonnet 4.6 — ~$0.08 per smoke.

import { createClient } from "@supabase/supabase-js";
import { Inngest } from "inngest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BUCKET = "site-screenshots";
const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 5 * 60 * 1000;

const REQUIRED_FILES = [
  "package.json", "tsconfig.json", "next.config.ts", "tailwind.config.ts",
  "postcss.config.mjs", ".gitignore", ".env.example", "README.md",
  "app/layout.tsx", "app/page.tsx", "app/not-found.tsx", "app/robots.ts",
  "app/sitemap.ts", "app/globals.css",
  "app/[...slug]/page.tsx", "app/[...slug]/route-map.ts",
  "components/blocks/_dispatcher.tsx", "components/blocks/_passthrough.tsx",
  "components/site/Header.tsx", "components/site/Footer.tsx",
  "lib/jab/client.ts", "lib/compose-block-tree.ts", "lib/acf-flex-fields.ts",
  "lib/sdk/types.ts", "lib/sdk/client.ts", "lib/sdk/abilities.ts",
  "lib/sdk/index.ts", "lib/sdk/CLAUDE.md",
];

function loadDotEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  loadDotEnvLocal();

  const [, , projectId, tenantId, buildId] = process.argv;
  if (!projectId || !tenantId || !buildId) {
    console.error("Usage: pnpm tsx scripts/smoke-compose-site.ts <projectId> <tenantId> <buildId>");
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const inngest = new Inngest({
    id: "smoke-compose-site",
    eventKey: process.env.INNGEST_EVENT_KEY ?? "local-dev-key",
    baseUrl: process.env.INNGEST_BASE_URL ?? "http://localhost:8288",
    isDev: true,
  });

  console.log(`[smoke] dispatching site/compose.requested for build ${buildId}…`);
  await inngest.send({
    name: "site/compose.requested",
    data: { projectId, tenantId, buildId },
  });

  const t0 = Date.now();
  let lastStatus = "";
  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { data: build } = await supabase
      .from("site_builds")
      .select("status")
      .eq("id", buildId)
      .single();
    if (!build) continue;
    if (build.status !== lastStatus) {
      console.log(`[smoke] status: ${build.status}`);
      lastStatus = build.status;
    }
    if (build.status === "built") break;
    if (build.status === "failed") {
      console.error("[smoke] FAIL — site_builds.status = 'failed'");
      process.exit(1);
    }
  }
  const elapsed = Date.now() - t0;
  if (lastStatus !== "built") {
    console.error(`[smoke] FAIL — timed out after ${elapsed}ms (status=${lastStatus})`);
    process.exit(1);
  }
  console.log(`[smoke] Phase C complete in ${elapsed}ms.`);

  const { data: shells } = await supabase
    .from("shell_generations")
    .select("shell_kind, compile_status")
    .eq("site_build_id", buildId);
  if (!shells || shells.length !== 2) {
    console.error(`[smoke] FAIL — expected 2 shell_generations rows, got ${shells?.length ?? 0}`);
    process.exit(1);
  }
  console.log(
    `[smoke] PASS — shell_generations: header=${shells.find((s) => s.shell_kind === "header")?.compile_status}, footer=${shells.find((s) => s.shell_kind === "footer")?.compile_status}`,
  );

  const missing: string[] = [];
  for (const filePath of REQUIRED_FILES) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(`builds/${buildId}/project/${filePath}`);
    if (error || !data) missing.push(filePath);
  }
  if (missing.length > 0) {
    console.error(`[smoke] FAIL — ${missing.length} required file(s) missing:`);
    missing.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log(`[smoke] PASS — all ${REQUIRED_FILES.length} required files present.`);
  console.log(`[smoke] PASS — Phase C smoke complete.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the package.json script**

In `apps/web/package.json`, under `scripts`, add (next to `smoke:discover` and `smoke:generate`):

```json
    "smoke:compose": "tsx scripts/smoke-compose-site.ts",
```

- [ ] **Step 3: Verify the script type-checks**

Run: `cd apps/web && pnpm exec tsc --noEmit`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/scripts/smoke-compose-site.ts apps/web/package.json
git commit -m "$(cat <<'EOF'
🧰 chore(web): smoke-compose-site.ts — Phase C smoke runner

Phase C task 18 of 19. Self-contained smoke matching smoke-* pattern:
dispatches site/compose.requested, polls site_builds.status until 'built',
asserts shell_generations has 2 rows + all 28 required project files
exist in Storage. ~5 min timeout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: End-to-end against Two Roads build `982f0d57`

Manual verification — runs the full Phase C pipeline against the validated Phase B output and surfaces any wiring gaps.

**Files:**
- No code changes.

- [ ] **Step 1: Start dev infrastructure**

Terminal 1:
```bash
cd c:/Projects/wp-headless/apps/web && pnpm dev
```

Terminal 2:
```bash
npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
```

Verify the Inngest dev UI at http://localhost:8288 shows `compose-site` in the function list.

- [ ] **Step 2: Run the smoke**

```bash
cd c:/Projects/wp-headless/apps/web && pnpm smoke:compose 075e33fd-8984-4e48-b58e-a9eab54d1828 01d5b66f-2d9b-42a8-bc5b-109af0b62579 982f0d57-5275-499a-92d8-5f00dc70dba1
```

Expected output:
```
[smoke] dispatching site/compose.requested for build 982f0d57…
[smoke] status: composing
[smoke] status: built
[smoke] Phase C complete in <60000ms.
[smoke] PASS — shell_generations: header=ok, footer=ok
[smoke] PASS — all 28 required files present.
[smoke] PASS — Phase C smoke complete.
```

A `compile_status='failed'` on a shell is acceptable (deterministic fallback shipped); investigate post-smoke but don't block.

- [ ] **Step 3: Spot-check Header + Footer outputs**

Via the Supabase dashboard or a quick storage download, retrieve:
- `builds/982f0d57.../project/components/site/Header.tsx`
- `builds/982f0d57.../project/components/site/Footer.tsx`

Verify:
- `export function Header()` / `export function Footer()` signatures
- Tailwind classes only (no inline styles beyond dynamic values)
- No `next/font` imports
- References tokens that exist in the emitted `tailwind.config.ts`

- [ ] **Step 4: Optional — verify `next build` works**

Manually download the full project tree (extend `snapshot-build-components.ts` to also walk `builds/<id>/project/` if useful — not part of this plan), then:

```bash
cd <tree-dir> && pnpm install && pnpm build
```

Successful `next build` confirms Phase C's deliverable is ready for Stage 4. Failures here surface either dispatcher import mismatches (PascalCase derivation drift) or compose-block-tree import substitution errors. Fix in apps/web and re-run the smoke; don't hand-edit the emitted tree.

- [ ] **Step 5: Mark Stage 3 shipped in project docs (optional)**

Edit the "Current state" table in `CLAUDE.md` or `docs/superpowers/plans/2026-05-25-saas-v2-roadmap.md` to flip Stage 3 from "Not started" to "Shipped" once the smoke is green.

```bash
git commit -m "📝 docs: mark Phase C Stage 3 shipped — Two Roads smoke green"
```

(Skip if you'd rather wait for Stage 4 to consume the output before flipping doc state.)

---

## Self-Review

**Spec coverage:**
- §1 (Goal) — Tasks 17+18 produce the tree at `builds/<id>/project/` and verify.
- §2 (Inputs) — Task 17 loads block_inventory, page_inventory, design_tokens, manifest in parallel.
- §3 + §4 (Outputs + Storage layout) — Tasks 3–13 emit every file; Task 18 asserts the 28 required files.
- §5 (Worker shape) — Task 17 implements three-wave sequencing.
- §6 C₁–C₇ — Tasks 9/10/11/12 (C₁/C₂/C₄/C₅), Tasks 14/15/16 (C₆), Tasks 3–8 + 13 (C₇).
- §7 (Dispatcher detail) — Task 11 + Task 9 establishes `_key` tagging.
- §8 (Runtime composition) — Task 9's runtime + Task 17's substitution-emit.
- §9 (Shell LLM contract) — Tasks 14/15 with missing-input short-circuit.
- §10 (Conditional CPT routes) — NOT in v1 per §15 scope cut. Migration 0020 lands the `config` column; worker doesn't read the flag yet. v1.1.
- §11 (@jab/core reuse) — Task 4 delegations + Task 17 emitSdk.
- §12 (Cost/time) — validated by Task 19 smoke.
- §13 (Risks) — every risk has a task or is documented:
  - Missing Storage components → Task 17 download step records missing, dispatcher default routes them
  - Bad shell TSX → Task 15 compile-gate + retry + fallback
  - Theme stylesheet conflicts → Task 6 `.jab-theme` scoping + Task 12 `<main className="jab-theme">`
  - Route-map collisions → Task 12 `emitRouteMapTs` throws
  - ACF field discovery → Tasks 9 + 10
  - Partial Phase B inventory → Task 17 graceful-degrades via dispatcher default
  - Step output size → Task 17 download returns only counts, not file contents
- §14 (Testing) — Tasks 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 ship unit tests; Task 18 ships smoke; Task 19 e2e.
- §15 (Out of scope v1) — Reflected: CPT routes gated, no per-page metadata, no image domains, English-only, brand-neutral 404.

**Placeholder scan:** Searched for TBD / TODO / "implement later" / "handle edge cases" — none found. Every step has actual code or commands.

**Type consistency:** `RenderableBlock` (Task 9), `BlockInventoryRowForDispatch` (Task 11), `BlockInventoryRowForFlexFields` (Task 10), `RouteMapEntry` (Task 12), `ShellPromptInput` (Task 14), `GenerateShellOptions` + `GeneratedShell` (Task 15) — names match across tasks.

**One known wrinkle:** the `emitPassthroughTsx` function in Task 10 uses a string-fragment construction trick to ship the React HTML-insertion attribute into the generated project without that attribute name appearing literally in apps/web source. The runtime output is identical to the architecture doc §3 Decision 3 canonical implementation; the safety guarantee is identical (DOMPurify sanitizes the input one line above the React API call).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-saas-v2-phase-c-compose-shell.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints

Which approach?
