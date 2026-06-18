# Global Design-Token Editing (Live Draft, preview-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user change brand design tokens (colors, heading/body fonts, type scale) from chat and see the change instantly in the Live Draft preview.

**Architecture:** Add a third planner scope `"tokens"` alongside `component`/`shell`. A token edit is **deterministic** (no patch LLM): the planner parses the NL request into a structured `TokenDelta`, which is stored on the `workspace_edits` row. The Live Draft worker merges all active (non-undone) token deltas into the base build's tokens (`applyTokenOverride`) and rebuilds the versioned draft artifacts — so `buildDraftCss` re-derives `tailwindExtendFromTokens` + `brandTypographyCss` from the overridden tokens and the preview restyles instantly. Token edits ride the existing draft undo/revert machinery (they're `workspace_edits` rows). **Preview-only:** like every draft edit today, this does not reach production — that is gated on the (separate, unbuilt) Live Draft publish bridge; when it lands, token overrides fold into the published build alongside component/shell edits.

**Tech Stack:** TypeScript, Next.js App Router, Inngest, Tailwind 3 JIT (draft CSS), vitest. One additive migration (0037).

## Global Constraints

- **Preview-only.** This plan touches NO production/publish path. It does not change `publishBuildAction`, compose, or deploy. Token edits show in the Live Draft; reaching production is the future publish-bridge's job.
- **Deterministic apply — no LLM to apply a token edit.** The planner LLM parses the request into a `TokenDelta`; applying it is a pure merge. No `patchUnitSource`, no `draft_unit_versions` row for token edits.
- **Rides undo/revert.** A token edit is a `workspace_edits` row (scope `"tokens"`, `token_delta` JSONB). Active = `status='completed' AND undone_at IS NULL`. Undo/revert recompute the override from the active set.
- **`buildDraftCss` is unchanged.** The override is applied to the tokens object (`applyTokenOverride`) BEFORE `buildCss` is called, so both `tailwindExtendFromTokens` and `brandTypographyCss` derive from the overridden tokens with no signature change.
- **Token values are validated/sanitized.** Colors must be a strict CSS color; font family / size are bounded strings (no `<>{};`, length-capped) — they flow into CSS now and the emitted tailwind config later.
- **Migration 0037 applies to BOTH Supabase projects** (local "JAB WP" `ajfurojjxthhzkjqttri` + prod "jab-prod" `celzwcxkrmsbwiswkxug`) — additive `token_delta jsonb` column. Apply before deploying worker code that writes it.
- **Commit trailer on every commit:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `apps/web/lib/jab/token-override.ts` (PURE) — `TokenDelta`, `mergeTokenDeltas`, `applyTokenOverride`, `isEmptyTokenDelta`, `validateTokenDelta`.
- **Create** `apps/web/lib/jab/token-override.test.ts`.
- **Modify** `apps/web/lib/jab/workspace-edit-validation.ts` — `WorkspaceEditScope` += `"tokens"`; `validateEditInput` tokens branch.
- **Modify** `apps/web/lib/jab/edit-plan.ts` — `EditPlan.tokenDelta`; `EDIT_PLAN_TOOL_SCHEMA` scope enum + `tokenDelta`; `validateEditPlan` tokens branch + new error codes.
- **Modify** `apps/web/lib/ai/edit-planner.ts` — `parsePlannerToolUse` parses `tokenDelta`; `buildSystemPrompt` tokens section.
- **Modify** `apps/web/lib/jab/site-map.ts` — `SiteMap.tokens`; `reduceSiteMap` + `buildSiteMap` load token summary.
- **Modify** `apps/web/lib/inngest/edit-request-event.ts` — `SiteEditRequestedData.tokenDelta`.
- **Modify** `apps/web/lib/actions/workspace-edit.ts` — persist `token_delta`, dispatch `tokenDelta`.
- **Modify** `apps/web/lib/db/drafts.ts` — `loadActiveTokenDeltas`.
- **Modify** `apps/web/lib/draft/artifacts.ts` — `VersionedArtifactArgs.tokenOverride`; apply before `buildCss`.
- **Modify** `apps/web/lib/inngest/functions/draft-edit.ts` — token branch (deterministic).
- **Modify** `apps/web/lib/actions/draft-actions.ts` — `rebuildDraftArtifacts` merges active token deltas.
- **Create** `apps/web/drizzle/migrations/0037_workspace_edits_token_delta.sql` + **modify** `apps/web/lib/db/schema.ts`.
- Test files alongside each; docs (`fleet-gap-register` A3, `CLAUDE.md`).

---

### Task 1: Token-delta types + pure merge/apply/validate (`token-override.ts`)

**Files:**
- Create: `apps/web/lib/jab/token-override.ts`
- Test: `apps/web/lib/jab/token-override.test.ts`

**Interfaces:**
- Consumes: `ThemeJsonTokens` (`@/lib/jab/global-styles`).
- Produces:
  - `interface TokenDelta { colors?: {slug,color}[]; fontFamilies?: {slug,fontFamily}[]; fontSizes?: {slug,size}[] }`.
  - `mergeTokenDeltas(deltas: TokenDelta[]): TokenDelta` — ordered upsert-by-slug per category (last wins).
  - `applyTokenOverride(base: ThemeJsonTokens | null, delta: TokenDelta): ThemeJsonTokens` — upsert slugs into colorPalette/fontFamilies/fontSizes.
  - `isEmptyTokenDelta(d: TokenDelta | null | undefined): boolean`.
  - `validateTokenDelta(d: unknown): { ok: true; delta: TokenDelta } | { ok: false; reason: string }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/jab/token-override.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  mergeTokenDeltas,
  applyTokenOverride,
  isEmptyTokenDelta,
  validateTokenDelta,
  type TokenDelta,
} from "./token-override";
import type { ThemeJsonTokens } from "./global-styles";

describe("mergeTokenDeltas", () => {
  it("upserts by slug per category, last delta wins", () => {
    const merged = mergeTokenDeltas([
      { colors: [{ slug: "primary", color: "#000" }] },
      { colors: [{ slug: "primary", color: "#c00" }, { slug: "secondary", color: "#0c0" }] },
      { fontFamilies: [{ slug: "heading", fontFamily: "Anton" }] },
    ]);
    expect(merged.colors).toEqual([
      { slug: "primary", color: "#c00" },
      { slug: "secondary", color: "#0c0" },
    ]);
    expect(merged.fontFamilies).toEqual([{ slug: "heading", fontFamily: "Anton" }]);
  });
  it("returns an empty delta for no input", () => {
    expect(isEmptyTokenDelta(mergeTokenDeltas([]))).toBe(true);
  });
});

describe("applyTokenOverride", () => {
  const base: ThemeJsonTokens = {
    colorPalette: [{ slug: "primary", color: "#000" }, { slug: "bg", color: "#fff" }],
    fontFamilies: [{ slug: "heading", fontFamily: "Georgia" }],
    fontSizes: [{ slug: "xl", size: "2rem" }],
  };
  it("overrides an existing color slug and keeps the rest", () => {
    const out = applyTokenOverride(base, { colors: [{ slug: "primary", color: "#c00" }] });
    expect(out.colorPalette).toEqual([{ slug: "primary", color: "#c00" }, { slug: "bg", color: "#fff" }]);
    expect(out.fontFamilies).toEqual(base.fontFamilies);
  });
  it("adds a new slug when absent", () => {
    const out = applyTokenOverride(base, { colors: [{ slug: "accent", color: "#0c0" }] });
    expect(out.colorPalette).toContainEqual({ slug: "accent", color: "#0c0" });
  });
  it("overrides fonts and sizes", () => {
    const out = applyTokenOverride(base, {
      fontFamilies: [{ slug: "heading", fontFamily: "Anton" }],
      fontSizes: [{ slug: "xl", size: "3rem" }],
    });
    expect(out.fontFamilies).toEqual([{ slug: "heading", fontFamily: "Anton" }]);
    expect(out.fontSizes).toEqual([{ slug: "xl", size: "3rem" }]);
  });
  it("starts from empty when base is null", () => {
    const out = applyTokenOverride(null, { colors: [{ slug: "primary", color: "#c00" }] });
    expect(out.colorPalette).toEqual([{ slug: "primary", color: "#c00" }]);
  });
});

describe("validateTokenDelta", () => {
  it("accepts valid hex / rgb / hsl colors", () => {
    expect(validateTokenDelta({ colors: [{ slug: "primary", color: "#c00" }] }).ok).toBe(true);
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "#cc0000" }] }).ok).toBe(true);
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "rgb(204,0,0)" }] }).ok).toBe(true);
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "hsl(0,100%,40%)" }] }).ok).toBe(true);
  });
  it("rejects a color that could break out of CSS", () => {
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "red; } body{display:none}" }] }).ok).toBe(false);
    expect(validateTokenDelta({ colors: [{ slug: "p", color: "url(x)" }] }).ok).toBe(false);
  });
  it("rejects font family / size with braces, semicolons, or angle brackets", () => {
    expect(validateTokenDelta({ fontFamilies: [{ slug: "h", fontFamily: "Anton; }" }] }).ok).toBe(false);
    expect(validateTokenDelta({ fontSizes: [{ slug: "xl", size: "3rem; }<x>" }] }).ok).toBe(false);
  });
  it("accepts a plain font family and a CSS length / clamp size", () => {
    expect(validateTokenDelta({ fontFamilies: [{ slug: "h", fontFamily: "DM Sans" }] }).ok).toBe(true);
    expect(validateTokenDelta({ fontSizes: [{ slug: "xl", size: "clamp(2rem, 5vw, 3rem)" }] }).ok).toBe(true);
  });
  it("rejects an empty delta and a non-object", () => {
    expect(validateTokenDelta({}).ok).toBe(false);
    expect(validateTokenDelta(null).ok).toBe(false);
    expect(validateTokenDelta("x").ok).toBe(false);
  });
  it("rejects a missing/blank slug", () => {
    expect(validateTokenDelta({ colors: [{ slug: "", color: "#c00" }] }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/token-override.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/jab/token-override.ts`:

```ts
// PURE module: structured brand-token deltas and how they merge/apply onto the
// ThemeJsonTokens object the draft + (future) build derive CSS from. No
// server-only — imported by the planner schema validation + the draft worker.

import type { ThemeJsonTokens } from "./global-styles";

export interface TokenDelta {
  colors?: Array<{ slug: string; color: string }>;
  fontFamilies?: Array<{ slug: string; fontFamily: string }>;
  fontSizes?: Array<{ slug: string; size: string }>;
}

export function isEmptyTokenDelta(d: TokenDelta | null | undefined): boolean {
  if (!d) return true;
  return !(d.colors?.length || d.fontFamilies?.length || d.fontSizes?.length);
}

/** Upsert-by-slug within one category; later entries win. */
function upsertBySlug<T extends { slug: string }>(existing: T[], incoming: T[]): T[] {
  const out = [...existing];
  for (const item of incoming) {
    const i = out.findIndex((e) => e.slug === item.slug);
    if (i >= 0) out[i] = item;
    else out.push(item);
  }
  return out;
}

/** Merge deltas in order (last wins per slug per category). */
export function mergeTokenDeltas(deltas: TokenDelta[]): TokenDelta {
  const merged: Required<TokenDelta> = { colors: [], fontFamilies: [], fontSizes: [] };
  for (const d of deltas) {
    if (d.colors?.length) merged.colors = upsertBySlug(merged.colors, d.colors);
    if (d.fontFamilies?.length) merged.fontFamilies = upsertBySlug(merged.fontFamilies, d.fontFamilies);
    if (d.fontSizes?.length) merged.fontSizes = upsertBySlug(merged.fontSizes, d.fontSizes);
  }
  const out: TokenDelta = {};
  if (merged.colors.length) out.colors = merged.colors;
  if (merged.fontFamilies.length) out.fontFamilies = merged.fontFamilies;
  if (merged.fontSizes.length) out.fontSizes = merged.fontSizes;
  return out;
}

/** Apply a delta onto base tokens (upsert by slug per category). */
export function applyTokenOverride(
  base: ThemeJsonTokens | null,
  delta: TokenDelta,
): ThemeJsonTokens {
  const out: ThemeJsonTokens = { ...(base ?? {}) };
  if (delta.colors?.length) out.colorPalette = upsertBySlug(out.colorPalette ?? [], delta.colors);
  if (delta.fontFamilies?.length) out.fontFamilies = upsertBySlug(out.fontFamilies ?? [], delta.fontFamilies);
  if (delta.fontSizes?.length) out.fontSizes = upsertBySlug(out.fontSizes ?? [], delta.fontSizes);
  return out;
}

// ── validation (injection-safe) ───────────────────────────────────────────────

// Strict CSS color: #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba()/hsl()/hsla(),
// or a plain lowercase keyword (letters only). NO url(), no semicolons/braces.
const COLOR_RE =
  /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\([0-9.,\s%]+\)|hsla?\([0-9.,\s%]+\)|[a-zA-Z]+)$/;
// Font family / size: no CSS-breaking chars. Sizes legitimately use parens
// (clamp/calc/min/max), so parens are allowed; braces/semicolons/angle-brackets
// and quotes-that-could-break-out are not.
const SAFE_VALUE_RE = /^[^{};<>]+$/;
const MAX_VALUE_LEN = 120;

function isSafeValue(v: string): boolean {
  return v.length > 0 && v.length <= MAX_VALUE_LEN && SAFE_VALUE_RE.test(v) && !/url\s*\(/i.test(v);
}

export function validateTokenDelta(
  d: unknown,
): { ok: true; delta: TokenDelta } | { ok: false; reason: string } {
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    return { ok: false, reason: "Token change is empty." };
  }
  const raw = d as TokenDelta;
  const delta: TokenDelta = {};

  if (raw.colors?.length) {
    for (const c of raw.colors) {
      if (!c || typeof c.slug !== "string" || !c.slug.trim()) return { ok: false, reason: "A color is missing its slug." };
      if (typeof c.color !== "string" || !COLOR_RE.test(c.color.trim()) || /url\s*\(/i.test(c.color)) {
        return { ok: false, reason: `"${c.color}" is not a valid CSS color.` };
      }
    }
    delta.colors = raw.colors.map((c) => ({ slug: c.slug.trim(), color: c.color.trim() }));
  }
  if (raw.fontFamilies?.length) {
    for (const f of raw.fontFamilies) {
      if (!f || typeof f.slug !== "string" || !f.slug.trim()) return { ok: false, reason: "A font is missing its slug." };
      if (typeof f.fontFamily !== "string" || !isSafeValue(f.fontFamily.trim())) {
        return { ok: false, reason: `"${f.fontFamily}" is not a valid font family.` };
      }
    }
    delta.fontFamilies = raw.fontFamilies.map((f) => ({ slug: f.slug.trim(), fontFamily: f.fontFamily.trim() }));
  }
  if (raw.fontSizes?.length) {
    for (const s of raw.fontSizes) {
      if (!s || typeof s.slug !== "string" || !s.slug.trim()) return { ok: false, reason: "A size is missing its slug." };
      if (typeof s.size !== "string" || !isSafeValue(s.size.trim())) {
        return { ok: false, reason: `"${s.size}" is not a valid font size.` };
      }
    }
    delta.fontSizes = raw.fontSizes.map((s) => ({ slug: s.slug.trim(), size: s.size.trim() }));
  }

  if (isEmptyTokenDelta(delta)) return { ok: false, reason: "Token change has no colors, fonts, or sizes." };
  return { ok: true, delta };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/token-override.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/token-override.ts apps/web/lib/jab/token-override.test.ts
git commit -m "feat(tokens): TokenDelta types + merge/apply/validate helpers (pure)"
```

---

### Task 2: Planner scope, EditPlan schema, validation

**Files:**
- Modify: `apps/web/lib/jab/workspace-edit-validation.ts` (scope union)
- Modify: `apps/web/lib/jab/edit-plan.ts`
- Modify: `apps/web/lib/ai/edit-planner.ts` (`parsePlannerToolUse`)
- Test: `apps/web/lib/jab/edit-plan.test.ts`, `apps/web/lib/ai/edit-planner.test.ts`

**Interfaces:**
- `WorkspaceEditScope = "component" | "shell" | "tokens"`.
- `EditPlan.tokenDelta?: TokenDelta | null`.
- `EDIT_PLAN_TOOL_SCHEMA`: scope enum += `"tokens"`; new `tokenDelta` property (object with colors/fontFamilies/fontSizes arrays, or null), added to `required`.
- `validateEditPlan`: tokens branch (validates via `validateTokenDelta`), new error codes `invalid_token_delta`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/lib/jab/edit-plan.test.ts`:

```ts
import { validateEditPlan } from "./edit-plan";
// ...existing imports / siteMap fixture (add tokens: { colors: [...], fonts: [...], sizes: [...] } once Task 3 lands;
//    for THIS task a SiteMap without tokens is fine — validateEditPlan(tokens) does not read siteMap.tokens)

const baseSiteMap = { blockTypes: [], pageSlugs: [], shell: { header: true, footer: true } } as any;

describe("validateEditPlan — tokens scope", () => {
  it("accepts a valid token delta", () => {
    const plan = {
      needsClarification: false, scope: "tokens" as const, target: "color:primary",
      action: "Set primary to #c00", regenerationPrompt: "n/a", clarifyingQuestion: null,
      tokenDelta: { colors: [{ slug: "primary", color: "#c00" }] },
    };
    expect(validateEditPlan(plan, baseSiteMap)).toEqual({ ok: true });
  });
  it("rejects a missing/empty token delta", () => {
    const plan = {
      needsClarification: false, scope: "tokens" as const, target: "",
      action: "x", regenerationPrompt: "n/a", clarifyingQuestion: null, tokenDelta: null,
    };
    const r = validateEditPlan(plan, baseSiteMap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_token_delta");
  });
  it("rejects an unsafe color", () => {
    const plan = {
      needsClarification: false, scope: "tokens" as const, target: "color:primary",
      action: "x", regenerationPrompt: "n/a", clarifyingQuestion: null,
      tokenDelta: { colors: [{ slug: "primary", color: "red;}" }] },
    };
    expect(validateEditPlan(plan, baseSiteMap).ok).toBe(false);
  });
  it("does NOT require regenerationPrompt for tokens (deterministic apply)", () => {
    const plan = {
      needsClarification: false, scope: "tokens" as const, target: "color:primary",
      action: "Set primary", regenerationPrompt: "", clarifyingQuestion: null,
      tokenDelta: { colors: [{ slug: "primary", color: "#c00" }] },
    };
    expect(validateEditPlan(plan, baseSiteMap)).toEqual({ ok: true });
  });
});
```

Add to `apps/web/lib/ai/edit-planner.test.ts` (parsePlannerToolUse):

```ts
describe("parsePlannerToolUse — tokenDelta", () => {
  it("parses a tokens plan with a token delta", () => {
    const plan = parsePlannerToolUse({
      needsClarification: false, scope: "tokens", target: "color:primary",
      action: "Set primary to #c00", regenerationPrompt: "", clarifyingQuestion: null,
      tokenDelta: { colors: [{ slug: "primary", color: "#c00" }] },
    });
    expect(plan.scope).toBe("tokens");
    expect(plan.tokenDelta).toEqual({ colors: [{ slug: "primary", color: "#c00" }] });
  });
  it("defaults tokenDelta to null when absent", () => {
    const plan = parsePlannerToolUse({ needsClarification: true, clarifyingQuestion: "?" });
    expect(plan.tokenDelta).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/edit-plan.test.ts lib/ai/edit-planner.test.ts -t "token"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/web/lib/jab/workspace-edit-validation.ts`, widen the union:

```ts
export type WorkspaceEditScope = "component" | "shell" | "tokens";
```

In `apps/web/lib/jab/edit-plan.ts`:
- Import `TokenDelta`, `validateTokenDelta`, `isEmptyTokenDelta` from `./token-override`.
- Add to `EditPlan`:

```ts
  /** Structured brand-token change for scope="tokens"; null otherwise. */
  tokenDelta: TokenDelta | null;
```

- Add to `EDIT_PLAN_TOOL_SCHEMA.input_schema.properties` (and to `required`):

```ts
      scope: { type: "string", enum: ["component", "shell", "tokens"] },
      // ...
      tokenDelta: {
        anyOf: [
          {
            type: "object",
            properties: {
              colors: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, color: { type: "string" } }, required: ["slug", "color"], additionalProperties: false } },
              fontFamilies: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, fontFamily: { type: "string" } }, required: ["slug", "fontFamily"], additionalProperties: false } },
              fontSizes: { type: "array", items: { type: "object", properties: { slug: { type: "string" }, size: { type: "string" } }, required: ["slug", "size"], additionalProperties: false } },
            },
            additionalProperties: false,
          },
          { type: "null" },
        ],
        description: "For scope=tokens ONLY: the brand-token change. colors[].color is a CSS color (e.g. #c00); fontFamilies[].fontFamily is a family name; fontSizes[].size is a CSS length. Use the EXACT slugs from the site map's design-tokens list (e.g. 'primary', 'heading', 'body'). null for component/shell/clarification.",
      },
```

Add `"tokenDelta"` to the `required` array.

- Add the `invalid_token_delta` code to `ValidateEditPlanResult` and a tokens branch in `validateEditPlan` (place it BEFORE the `empty_guidance` check, because tokens don't use `regenerationPrompt`):

```ts
export type ValidateEditPlanResult =
  | { ok: true }
  | {
      ok: false;
      code: "unknown_target" | "invalid_shell_target" | "shell_absent" | "empty_guidance" | "invalid_token_delta";
      reason: string;
    };

export function validateEditPlan(plan: EditPlan, siteMap: SiteMap): ValidateEditPlanResult {
  if (plan.needsClarification) return { ok: true };

  if (plan.scope === "tokens") {
    const v = validateTokenDelta(plan.tokenDelta);
    if (!v.ok) return { ok: false, code: "invalid_token_delta", reason: v.reason };
    return { ok: true };
  }

  // ...existing empty_guidance + shell + component branches unchanged
}
```

In `apps/web/lib/ai/edit-planner.ts` `parsePlannerToolUse`, parse the new field (defensive) and widen the scope guard:

```ts
function isScope(v: unknown): v is WorkspaceEditScope {
  return v === "component" || v === "shell" || v === "tokens";
}

export function parsePlannerToolUse(input: Record<string, unknown>): EditPlan {
  const scope = isScope(input.scope) ? input.scope : "component";
  return {
    // ...existing fields...
    tokenDelta:
      input.tokenDelta && typeof input.tokenDelta === "object" && !Array.isArray(input.tokenDelta)
        ? (input.tokenDelta as TokenDelta)
        : null,
  };
}
```

(Import `TokenDelta` into edit-planner.ts.)

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/edit-plan.test.ts lib/ai/edit-planner.test.ts`
Expected: PASS (existing component/shell tests unchanged — the new schema field is additive; verify the EDIT_PLAN_TOOL_SCHEMA shape test, if any, is updated for the new property + enum).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/workspace-edit-validation.ts apps/web/lib/jab/edit-plan.ts apps/web/lib/ai/edit-planner.ts apps/web/lib/jab/edit-plan.test.ts apps/web/lib/ai/edit-planner.test.ts
git commit -m "feat(tokens): planner scope=tokens + tokenDelta schema + validation"
```

---

### Task 3: SiteMap token summary

**Files:**
- Modify: `apps/web/lib/jab/site-map.ts`
- Test: `apps/web/lib/jab/site-map.test.ts`

**Interfaces:**
- `SiteMap.tokens: { colors: {slug,color}[]; fonts: {slug,fontFamily}[]; sizes: {slug,size}[] }`.
- `reduceSiteMap` accepts a `tokens: ThemeJsonTokens | null` input and maps it into the summary.
- `buildSiteMap` loads `projects.design_tokens` (via `resolveThemeTokens`) for the source build's project and passes it.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/jab/site-map.test.ts`:

```ts
describe("reduceSiteMap — tokens", () => {
  it("maps theme tokens into a compact summary", () => {
    const map = reduceSiteMap({
      blockRows: [], pageRows: [], hasHeader: true, hasFooter: false,
      tokens: {
        colorPalette: [{ slug: "primary", color: "#c00" }],
        fontFamilies: [{ slug: "heading", fontFamily: "Anton" }],
        fontSizes: [{ slug: "xl", size: "2rem" }],
      },
    });
    expect(map.tokens.colors).toEqual([{ slug: "primary", color: "#c00" }]);
    expect(map.tokens.fonts).toEqual([{ slug: "heading", fontFamily: "Anton" }]);
    expect(map.tokens.sizes).toEqual([{ slug: "xl", size: "2rem" }]);
  });
  it("yields empty token arrays when no tokens", () => {
    const map = reduceSiteMap({ blockRows: [], pageRows: [], hasHeader: false, hasFooter: false, tokens: null });
    expect(map.tokens).toEqual({ colors: [], fonts: [], sizes: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/site-map.test.ts -t "tokens"`
Expected: FAIL (`tokens` not on `ReduceSiteMapInput`/`SiteMap`).

- [ ] **Step 3: Implement**

In `apps/web/lib/jab/site-map.ts`:
- Import `ThemeJsonTokens` + `resolveThemeTokens` from `@/lib/jab/global-styles` and the design_tokens shape (mirror artifacts.ts `loadProjectMeta`).
- Add to `SiteMap`:

```ts
  tokens: {
    colors: Array<{ slug: string; color: string }>;
    fonts: Array<{ slug: string; fontFamily: string }>;
    sizes: Array<{ slug: string; size: string }>;
  };
```

- Add `tokens: ThemeJsonTokens | null` to `ReduceSiteMapInput`, and in `reduceSiteMap`'s return:

```ts
    tokens: {
      colors: input.tokens?.colorPalette ?? [],
      fonts: input.tokens?.fontFamilies ?? [],
      sizes: input.tokens?.fontSizes ?? [],
    },
```

- In `buildSiteMap`, load the project's design_tokens for the source build and resolve them. Add a 4th parallel read for the build's project id + design_tokens (a build row → project_id → projects.design_tokens), OR read `site_builds → project_id` then `projects.design_tokens`. Resolve with `resolveThemeTokens(dt.themeJson, { colors: dt.colors, typography: dt.typography })` (same as artifacts.ts loadProjectMeta lines 209-231). Fail SOFT to `null` tokens (a missing token table must not break the planner — mirror the shell-presence fail-soft posture). Pass `tokens` into `reduceSiteMap`.

```ts
// inside buildSiteMap, after loading blocks/pages/shell:
const tokens = await loadSourceBuildTokens(sourceBuildId).catch(() => null);
// ...
return reduceSiteMap({ blockRows, pageRows, hasHeader, hasFooter, tokens });
```

Add a `loadSourceBuildTokens(sourceBuildId)` helper that reads `site_builds.project_id`, then `projects.design_tokens`, and resolves tokens. (Reuse the exact resolve logic from artifacts.ts loadProjectMeta.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/site-map.test.ts`
Expected: PASS (existing reduceSiteMap tests need the new `tokens: null` input added to their `reduceSiteMap` calls — update those call sites to pass `tokens: null`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/site-map.ts apps/web/lib/jab/site-map.test.ts
git commit -m "feat(tokens): SiteMap design-token summary for the planner"
```

---

### Task 4: Planner system prompt — tokens section

**Files:**
- Modify: `apps/web/lib/ai/edit-planner.ts` (`buildSystemPrompt`)
- Test: `apps/web/lib/ai/edit-planner.test.ts`

**Interfaces:** consumes `siteMap.tokens` (Task 3); no exported surface change.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/lib/ai/edit-planner.test.ts` (the prompt builder is exported as `buildSystemPromptForTest`):

```ts
it("lists editable design tokens and teaches scope=tokens", () => {
  const map = {
    blockTypes: [], pageSlugs: ["home"], shell: { header: true, footer: false },
    tokens: {
      colors: [{ slug: "primary", color: "#c00" }],
      fonts: [{ slug: "heading", fontFamily: "Anton" }],
      sizes: [{ slug: "xl", size: "2rem" }],
    },
  } as any;
  const p = buildSystemPromptForTest(map);
  expect(p).toContain("tokens");
  expect(p).toContain("primary");
  expect(p).toContain("#c00");
  expect(p).toContain("heading");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/edit-planner.test.ts -t "design tokens"`
Expected: FAIL (prompt has no tokens section).

- [ ] **Step 3: Implement**

In `buildSystemPrompt(siteMap)`, render a tokens section and add a scope option. After the shell section:

```ts
  const tokenLines = [
    ...siteMap.tokens.colors.map((c) => `- color "${c.slug}" (currently ${c.color})`),
    ...siteMap.tokens.fonts.map((f) => `- font "${f.slug}" (currently ${f.fontFamily})`),
    ...siteMap.tokens.sizes.map((s) => `- size "${s.slug}" (currently ${s.size})`),
  ].join("\n");
  const tokensSection = `

## Global design tokens (scope="tokens"; no block target)
These brand tokens apply site-wide. To change one, set scope="tokens", leave
target as a short label (e.g. "color:primary"), and fill tokenDelta with the
EXACT slug(s) below and the new value(s). regenerationPrompt is unused for tokens.
${tokenLines || "(no editable tokens captured)"}

Examples:
- "make the brand color red" → scope="tokens", tokenDelta={colors:[{slug:"primary",color:"#c00"}]}
- "use a bigger heading font size" → scope="tokens", tokenDelta={fontSizes:[{slug:"<the heading size slug above>",size:"<larger value>"}]}
A token change restyles every component that uses that token. Pick the slug whose
current value best matches what the user means; if no slug fits, ask a clarifying question.`;
```

Append `tokensSection` to the returned prompt, and update the "You may ONLY target one of these regenerable units" framing to include tokens. Keep the existing component/shell sections intact.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/edit-planner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/edit-planner.ts apps/web/lib/ai/edit-planner.test.ts
git commit -m "feat(tokens): planner prompt design-token section"
```

---

### Task 5: Migration + dispatch (persist token_delta, carry through the event)

**Files:**
- Create: `apps/web/drizzle/migrations/0037_workspace_edits_token_delta.sql`
- Modify: `apps/web/lib/db/schema.ts`
- Modify: `apps/web/lib/inngest/edit-request-event.ts` (`SiteEditRequestedData`)
- Modify: `apps/web/lib/actions/workspace-edit.ts` (persist + dispatch); `apps/web/lib/jab/workspace-edit-validation.ts` (`validateEditInput` tokens branch)
- Test: `apps/web/lib/jab/workspace-edit-validation.test.ts`, `apps/web/lib/actions/workspace-edit.test.ts`

**Interfaces:**
- `workspace_edits.token_delta jsonb` (nullable).
- `SiteEditRequestedData.tokenDelta?: TokenDelta | null`.
- `validateEditInput` accepts `scope="tokens"` (no target/prompt constraints; the planner already validated the delta via `validateEditPlan`).

- [ ] **Step 1: Write the migration**

Create `apps/web/drizzle/migrations/0037_workspace_edits_token_delta.sql`:

```sql
ALTER TABLE workspace_edits ADD COLUMN IF NOT EXISTS token_delta jsonb;
```

Add the column to `workspace_edits` in `apps/web/lib/db/schema.ts`:

```ts
  tokenDelta: jsonb("token_delta"),
```

- [ ] **Step 2: Write the failing validation + dispatch tests**

Add to `apps/web/lib/jab/workspace-edit-validation.test.ts`:

```ts
it("accepts scope=tokens without a block target", () => {
  expect(() => validateEditInput({ scope: "tokens", target: "color:primary", prompt: "make it red" })).not.toThrow();
});
it("does not require a non-empty target for tokens", () => {
  expect(() => validateEditInput({ scope: "tokens", target: "", prompt: "make it red" })).not.toThrow();
});
```

Add to `apps/web/lib/actions/workspace-edit.test.ts` a case asserting that a tokens edit persists `token_delta` and dispatches it (mirror the existing requestWorkspaceEditAction test pattern; assert the inserted row carries `token_delta` and the dispatched event data carries `tokenDelta`).

- [ ] **Step 3: Implement**

In `validateEditInput` (workspace-edit-validation.ts), add a tokens branch that returns early (valid) before the component/shell target checks — a tokens edit has no block target and its delta was validated by `validateEditPlan`. Keep the `page` rejection. Keep the prompt-length checks (the user's NL message still flows as the prompt).

```ts
  if (scopeValue === "tokens") {
    // target is a free label; the TokenDelta was validated upstream (validateEditPlan).
    // fall through to the prompt-length checks only.
  } else if (scopeValue !== "component" && scopeValue !== "shell") {
    throw new WorkspaceEditError("invalid_scope", `scope must be 'component', 'shell', or 'tokens' (got '${scopeValue}').`);
  } else if (input.scope === "shell" && input.target !== "header" && input.target !== "footer") {
    // ...existing
  } else if (input.scope === "component" && !input.target.trim()) {
    // ...existing
  }
  // ...existing prompt-length checks unchanged
```

(Restructure so the tokens branch skips the target checks but still runs the prompt checks.)

In `apps/web/lib/inngest/edit-request-event.ts`, add `tokenDelta?: TokenDelta | null` to `SiteEditRequestedData` (import the type).

In `apps/web/lib/actions/workspace-edit.ts` `requestWorkspaceEditAction`: thread the plan's `tokenDelta` from the caller (the chat action passes it), persist it in the `workspace_edits` insert (`token_delta: tokenDelta ?? null`), and include it in the dispatched `SiteEditRequestedData`. Trace the call from `sendChatMessageAction` (workspace-chat.ts) → it already passes scope/target/prompt/regenerationPrompt/action; add `tokenDelta: plan.tokenDelta`.

- [ ] **Step 4: Run to verify + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/workspace-edit-validation.test.ts lib/actions/workspace-edit.test.ts`
Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/drizzle/migrations/0037_workspace_edits_token_delta.sql apps/web/lib/db/schema.ts apps/web/lib/inngest/edit-request-event.ts apps/web/lib/actions/workspace-edit.ts apps/web/lib/jab/workspace-edit-validation.ts apps/web/lib/jab/workspace-edit-validation.test.ts apps/web/lib/actions/workspace-edit.test.ts
git commit -m "feat(tokens): persist token_delta + carry through the edit event (migration 0037)"
```

---

### Task 6: Token-override loader + artifacts threading

**Files:**
- Modify: `apps/web/lib/db/drafts.ts` (`loadActiveTokenDeltas`)
- Modify: `apps/web/lib/draft/artifacts.ts` (`VersionedArtifactArgs.tokenOverride` + apply before `buildCss`)
- Test: `apps/web/lib/db/drafts.test.ts`, `apps/web/lib/draft/artifacts.test.ts`

**Interfaces:**
- `loadActiveTokenDeltas(draftId: string): Promise<TokenDelta[]>` — completed, non-undone, scope=tokens, non-null delta, `created_at ASC`.
- `VersionedArtifactArgs.tokenOverride?: TokenDelta | null` — applied to `meta.tokens` (via `applyTokenOverride`) before `deps.buildCss`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/lib/draft/artifacts.test.ts` a case proving `tokenOverride` reaches `buildCss` with the merged tokens. Using the injectable `ArtifactDeps`, spy on `buildCss` and assert the `tokens` it receives include the override (e.g. base `primary=#000`, override `primary=#c00` → `buildCss` sees `colorPalette` with `primary=#c00`):

```ts
it("applies tokenOverride onto meta.tokens before buildCss", async () => {
  let seenTokens: ThemeJsonTokens | null = null;
  const deps = makeFakeDeps({
    meta: { wpUrl: "https://x", tokens: { colorPalette: [{ slug: "primary", color: "#000" }] }, themeCss: null },
    buildCss: async (input) => { seenTokens = input.tokens; return "css"; },
  });
  await buildVersionedDraftArtifacts(
    { draftId: "d", nextVersion: 1, baseBuildId: "b", overrides: new Map(), tokenOverride: { colors: [{ slug: "primary", color: "#c00" }] } },
    deps,
  );
  expect(seenTokens?.colorPalette).toContainEqual({ slug: "primary", color: "#c00" });
});
```

(If `artifacts.test.ts` lacks a `makeFakeDeps`, add a minimal `ArtifactDeps` fake covering loadInventory→[], loadComponentSources→{}, loadShellSource→null, loadProjectMeta→meta, bundle→{js:""}, buildCss→spy, artifactExists→false, upload→noop.)

Add to `apps/web/lib/db/drafts.test.ts` a `loadActiveTokenDeltas` case (mirror the existing `loadDraftVersions` mock pattern — assert it queries scope=tokens, status=completed, undone_at null, and returns the deltas in created_at order).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/artifacts.test.ts lib/db/drafts.test.ts -t "token"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `apps/web/lib/db/drafts.ts`:

```ts
import type { TokenDelta } from "@/lib/jab/token-override";

export async function loadActiveTokenDeltas(draftId: string): Promise<TokenDelta[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workspace_edits")
    .select("token_delta, created_at")
    .eq("draft_id", draftId)
    .eq("scope", "tokens")
    .eq("status", "completed")
    .is("undone_at", null)
    .not("token_delta", "is", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`loadActiveTokenDeltas failed: ${error.message}`);
  return (data ?? [])
    .map((r) => (r as { token_delta: TokenDelta | null }).token_delta)
    .filter((d): d is TokenDelta => d != null);
}
```

In `apps/web/lib/draft/artifacts.ts`:
- Import `applyTokenOverride, type TokenDelta` from `@/lib/jab/token-override`.
- Add `tokenOverride?: TokenDelta | null` to `VersionedArtifactArgs`.
- In `buildVersionedDraftArtifacts`, after `meta` is loaded, replace the `tokens: meta.tokens` passed to `deps.buildCss`:

```ts
  const effectiveTokens = args.tokenOverride
    ? applyTokenOverride(meta.tokens, args.tokenOverride)
    : meta.tokens;
  // ...
  const css = await deps.buildCss({
    sources: [...Object.values(componentSources), headerSource ?? "", footerSource ?? ""],
    tokens: effectiveTokens,
    themeCss: meta.themeCss,
  });
```

(The bundle is unaffected — token changes are CSS-only. `buildDraftCss` is unchanged.)

- [ ] **Step 4: Run to verify + typecheck**

Run: `pnpm --filter @jab/web exec vitest run lib/draft/artifacts.test.ts lib/db/drafts.test.ts`
Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/db/drafts.ts apps/web/lib/draft/artifacts.ts apps/web/lib/db/drafts.test.ts apps/web/lib/draft/artifacts.test.ts
git commit -m "feat(tokens): active-token-delta loader + artifacts tokenOverride threading"
```

---

### Task 7: draft-edit worker token branch + undo/revert integration

**Files:**
- Modify: `apps/web/lib/inngest/functions/draft-edit.ts`
- Modify: `apps/web/lib/actions/draft-actions.ts`

**Interfaces:** worker wiring only; verified by `tsc` + the suite (the merge/loader/threading are unit-tested in Tasks 1/6).

- [ ] **Step 1: Add the deterministic token branch to the worker**

In `apps/web/lib/inngest/functions/draft-edit.ts`, after the `ensure-draft` step (after `if (!draft) return { failed: true };`, ~line 178), insert a token branch that returns before the load-source/patch path:

```ts
    // ── scope="tokens": deterministic, no patch LLM, no draft_unit_versions row.
    if (scope === "tokens") {
      const tokenArtifacts = await step.run("token-bundle-and-css", async () => {
        const [versions, steps, priorDeltas] = await Promise.all([
          loadDraftVersions(draft.id),
          loadDraftSteps(draft.id),
          loadActiveTokenDeltas(draft.id),
        ]);
        // Component/shell overrides carry forward unchanged; merge prior active
        // token deltas + THIS edit's delta (newest last → wins on slug conflict).
        const effective = effectiveUnitVersions(versions, steps);
        const overrides = new Map<string, string>();
        for (const [key, row] of effective) overrides.set(key, row.tsx);
        const tokenOverride = mergeTokenDeltas([...priorDeltas, data.tokenDelta ?? {}]);
        return buildVersionedDraftArtifacts(
          { draftId: draft.id, nextVersion: draft.version + 1, baseBuildId: draft.base_build_id, overrides, tokenOverride },
          defaultArtifactDeps(projectId),
        );
      }).catch(async (err: unknown) => {
        await failEdit(`token apply: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (!tokenArtifacts) return { failed: true };

      await step.run("token-commit", async () => {
        // A token change is global — it restyles every page that uses the token.
        const sourcePages = await loadSourcePagesForImpact(draft.base_build_id);
        const { error: eErr } = await admin
          .from("workspace_edits")
          .update({
            status: "completed",
            changed_slugs: sourcePages.map((p) => p.slug),
            change_reason: null,
            finished_at: new Date().toISOString(),
          })
          .eq("id", editId)
          .eq("status", "running");
        if (eErr) throw new Error(`token edit update failed: ${eErr.message}`);
        await bumpDraftVersion(draft.id, draft.version); // CAS, last write
      }).catch(async (err: unknown) => {
        await failEdit(`token commit: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

      return { draftId: draft.id, version: draft.version + 1, tokens: true };
    }
```

Add the imports: `loadActiveTokenDeltas` from `@/lib/db/drafts`, `mergeTokenDeltas` from `@/lib/jab/token-override`.

(The token branch does NOT insert a `draft_unit_versions` row — a token edit has no TSX unit. Orphan safety: if the worker crashes before `token-commit`, the edit stays `running` and `loadActiveTokenDeltas` excludes it; `autoFailStaleOpenEdits` sweeps it.)

- [ ] **Step 2: Make undo/revert recompute the token override**

In `apps/web/lib/actions/draft-actions.ts` `rebuildDraftArtifacts`, load active token deltas and pass the merged override so undo/revert of a token edit recomputes the preview:

```ts
import { loadActiveTokenDeltas } from "@/lib/db/drafts";
import { mergeTokenDeltas } from "@/lib/jab/token-override";

async function rebuildDraftArtifacts(draft: DraftRow, projectId: string): Promise<number> {
  const [versions, steps, tokenDeltas] = await Promise.all([
    loadDraftVersions(draft.id),
    loadDraftSteps(draft.id),
    loadActiveTokenDeltas(draft.id),
  ]);
  const effective = effectiveUnitVersions(versions, steps);
  const overrides = new Map<string, string>();
  for (const [key, row] of effective) overrides.set(key, row.tsx);
  const tokenOverride = mergeTokenDeltas(tokenDeltas);
  const nextVersion = draft.version + 1;
  await buildVersionedDraftArtifacts(
    { draftId: draft.id, nextVersion, baseBuildId: draft.base_build_id, overrides, tokenOverride },
    defaultArtifactDeps(projectId),
  );
  await bumpDraftVersion(draft.id, draft.version);
  return nextVersion;
}
```

(`loadActiveTokenDeltas` already excludes undone edits, so undoing a token edit drops its delta from the merge on the next rebuild. `mergeTokenDeltas([])` is an empty delta → `applyTokenOverride` is a no-op → byte-identical to today for drafts with no token edits.)

- [ ] **Step 3: Verify the whole app typechecks and the suite is green**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Run: `pnpm --filter @jab/web test`
Expected: clean / full suite green (no token edits in existing fixtures → `tokenOverride` is an empty/undefined no-op everywhere; component & shell paths unchanged).

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/inngest/functions/draft-edit.ts apps/web/lib/actions/draft-actions.ts
git commit -m "feat(tokens): deterministic token edit worker branch + undo/revert recompute"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md` (A3)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update fleet-gap A3**

Mark A3 PARTIAL: brand color / font / type-scale editing from chat lands in the **Live Draft preview** (new `scope="tokens"`, `TokenDelta` on `workspace_edits.token_delta` (migration 0037), deterministic apply via `applyTokenOverride` in the draft artifacts, rides undo/revert). **Remaining: production-reach** — token overrides reach production only when the (separate, unbuilt) Live Draft publish bridge lands, which gates ALL draft edits. Reference this plan.

- [ ] **Step 2: Add a CLAUDE.md snapshot paragraph**

Describe global-token editing landing preview-only behind the Live Draft (scope=tokens, deterministic TokenDelta apply, migration 0037, no LLM to apply, undo/revert-integrated), and the explicit residual: production-reach is gated on the Live Draft publish bridge. Reference this plan. Note migration 0037 must be applied to BOTH Supabase projects.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md CLAUDE.md
git commit -m "docs(tokens): record preview-only global-token editing"
```

---

## Operator step at merge

Apply migration 0037 (`workspace_edits.token_delta jsonb`) to BOTH Supabase projects (local "JAB WP" `ajfurojjxthhzkjqttri` + prod "jab-prod" `celzwcxkrmsbwiswkxug`) — additive nullable column. Apply before deploying worker code that writes it.

## Out of scope (documented residuals)

- **Production-reach.** Preview-only. Token overrides fold into the published build when the Live Draft publish bridge is built (gates every draft edit, not just tokens).
- **Components that hardcode values.** A token edit only restyles components that used the token class (`bg-primary`, `font-heading`, `text-<size>`). A component that hardcoded a hex is unaffected — that's a generation-quality concern, not a token-edit concern.
- **New-slug discoverability.** The planner can upsert a slug that no component references (it just won't show). v1 relies on the SiteMap token list to steer it to real slugs.
- **Draft `<html lang>`/scaffold** and other A9/A8 residuals are unrelated.
```

