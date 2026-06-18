# Locale / RTL Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generated (deployed) clones emit `<html lang>` from the source WordPress locale and `dir="rtl"` for RTL locales, instead of a hardcoded `lang="en"`.

**Architecture:** The WP locale (`site.locale`, e.g. `"en_US"`) is already fetched at discovery via `getSiteManifest` and dropped. Persist it into the existing `site_builds.config` JSONB (no migration, mirroring `show_on_front`), then at compose time derive a BCP-47 `lang` + `dir` via pure helpers and thread them into `emitLayoutTsx`'s `<html>` tag. Default-on with no flag: `en_US → "en"` and omitting `dir` for LTR keeps every English/LTR site byte-identical, so only non-English/RTL sites change.

**Tech Stack:** TypeScript, Next.js App Router, Inngest worker, vitest. Pure string/derivation helpers; no DB migration.

## Global Constraints

- **No flag — default-on, byte-identical for English/LTR.** `localeToBcp47("en_US")` returns `"en"` and `dir` is omitted for LTR, so an English site's `<html lang="en" id="jab-app">` is unchanged. Only non-English sites (`lang` changes) and RTL sites (`dir="rtl"` added) differ. `id="jab-app"` is load-bearing (Tailwind `important` scope) and MUST be preserved verbatim.
- **No DB migration.** `locale` rides `site_builds.config` JSONB.
- **Deployed path only.** This plan changes `emitLayoutTsx` (compose). The draft shell (`lib/draft/html-shell.ts`, `app/draft/[projectId]/route.ts`) and the kit `scaffold.ts` keep `lang="en"` — documented follow-ups (per fleet-gap A9's "deployed-site only" scope).
- **Region dropped by design.** `en_US → "en"`, `de_DE → "de"` (language subtag only). Preserving region (`de-DE`) is a documented follow-up; the language subtag is what matters for SEO/screen-readers and is all RTL detection needs.
- **Commit trailer on every commit:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `apps/web/lib/jab/locale.ts` (PURE) — `localeToBcp47`, `localeDir`, `RTL_LANGUAGE_SUBTAGS`.
- **Create** `apps/web/lib/jab/locale.test.ts`.
- **Modify** `apps/web/lib/jab/compose-site-emit.ts` — `emitLayoutTsx` gains `lang`/`dir` params, interpolated into `<html>`.
- **Modify** `apps/web/lib/jab/compose-site-emit.test.ts` — parameterize the `<html>` assertions + add locale variants.
- **Modify** `apps/web/lib/jab/build-config.ts` — `locale?` on both `BuildConfig` unions; `buildLocaleConfigPatch`; `locale` on `CarriedSourceConfig` + `carryForwardSourceConfig`.
- **Modify** `apps/web/lib/jab/build-config.test.ts` — cover the new patch + carry-forward.
- **Modify** `apps/web/lib/inngest/functions/discover-site.ts` — persist `siteManifest.site.locale` into `config`.
- **Modify** `apps/web/lib/inngest/functions/compose-site.ts` — derive `lang`/`dir` from `config.locale`, pass to `emitLayoutTsx`.
- **Modify** docs (fleet-gap A9, CLAUDE.md).

---

### Task 1: Locale derivation helpers (`locale.ts`)

**Files:**
- Create: `apps/web/lib/jab/locale.ts`
- Test: `apps/web/lib/jab/locale.test.ts`

**Interfaces:**
- Produces:
  - `localeToBcp47(wpLocale: string | null | undefined): string` — language subtag, lowercased; `"en"` when absent/empty.
  - `localeDir(wpLocale: string | null | undefined): "ltr" | "rtl"` — `"rtl"` for known RTL language subtags, else `"ltr"`.
  - `RTL_LANGUAGE_SUBTAGS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/jab/locale.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { localeToBcp47, localeDir } from "./locale";

describe("localeToBcp47", () => {
  it("drops the region and lowercases (en_US → en, de_DE → de)", () => {
    expect(localeToBcp47("en_US")).toBe("en");
    expect(localeToBcp47("de_DE")).toBe("de");
    expect(localeToBcp47("pt_BR")).toBe("pt");
    expect(localeToBcp47("FR_fr")).toBe("fr");
  });

  it("passes through bare language subtags", () => {
    expect(localeToBcp47("ar")).toBe("ar");
    expect(localeToBcp47("ckb")).toBe("ckb");
  });

  it("accepts hyphenated input too (de-DE → de)", () => {
    expect(localeToBcp47("de-DE")).toBe("de");
  });

  it("defaults to en for null/undefined/empty", () => {
    expect(localeToBcp47(null)).toBe("en");
    expect(localeToBcp47(undefined)).toBe("en");
    expect(localeToBcp47("")).toBe("en");
    expect(localeToBcp47("   ")).toBe("en");
  });
});

describe("localeDir", () => {
  it("returns rtl for known RTL languages (ignoring region)", () => {
    expect(localeDir("ar")).toBe("rtl");
    expect(localeDir("he_IL")).toBe("rtl");
    expect(localeDir("fa_IR")).toBe("rtl");
    expect(localeDir("ur")).toBe("rtl");
    expect(localeDir("ckb")).toBe("rtl");
    expect(localeDir("ps")).toBe("rtl");
  });

  it("returns ltr for LTR languages and unknowns", () => {
    expect(localeDir("en_US")).toBe("ltr");
    expect(localeDir("de_DE")).toBe("ltr");
    expect(localeDir("ja")).toBe("ltr");
    expect(localeDir("zz")).toBe("ltr");
  });

  it("defaults to ltr for null/undefined/empty", () => {
    expect(localeDir(null)).toBe("ltr");
    expect(localeDir(undefined)).toBe("ltr");
    expect(localeDir("")).toBe("ltr");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/locale.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/jab/locale.ts`:

```ts
// PURE module: WordPress locale → BCP-47 lang + text direction for the
// generated site's <html> tag. WP locales look like "en_US" / "de_DE" / "ar" /
// "ckb"; we take the language subtag only (region dropped — see plan), which is
// what matters for SEO/screen-readers and all RTL detection needs.

/**
 * Language subtags whose script is right-to-left. Covers the RTL locales
 * WordPress ships (Arabic + variants, Hebrew, Persian, Urdu, Pashto, Sindhi,
 * Uyghur, Yiddish, Divehi, Sorani Kurdish, South Azerbaijani, Hazaragi).
 * Region is stripped before lookup, so "fa_IR" and "fa" both resolve.
 */
export const RTL_LANGUAGE_SUBTAGS: ReadonlySet<string> = new Set([
  "ar", "ary", "azb", "ckb", "dv", "fa", "haz", "he", "ps", "sd", "ug", "ur", "yi",
]);

/** Language subtag, lowercased; "" when absent/blank. */
function languageSubtag(wpLocale: string | null | undefined): string {
  if (!wpLocale) return "";
  const trimmed = wpLocale.trim();
  if (!trimmed) return "";
  return trimmed.split(/[_-]/)[0].toLowerCase();
}

/** BCP-47 lang for `<html lang>`. Region dropped; defaults to "en". */
export function localeToBcp47(wpLocale: string | null | undefined): string {
  return languageSubtag(wpLocale) || "en";
}

/** Text direction for `<html dir>`. "rtl" for known RTL languages, else "ltr". */
export function localeDir(wpLocale: string | null | undefined): "ltr" | "rtl" {
  const subtag = languageSubtag(wpLocale);
  return subtag && RTL_LANGUAGE_SUBTAGS.has(subtag) ? "rtl" : "ltr";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/locale.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/locale.ts apps/web/lib/jab/locale.test.ts
git commit -m "feat(locale): WP-locale → BCP-47 lang + dir helpers"
```

---

### Task 2: Thread lang/dir into emitLayoutTsx

**Files:**
- Modify: `apps/web/lib/jab/compose-site-emit.ts`
- Test: `apps/web/lib/jab/compose-site-emit.test.ts`

**Interfaces:**
- Produces: `emitLayoutTsx(projectName, description, fontLinkHrefs?, lang?, dir?)` — `lang` defaults `"en"`, `dir` defaults `"ltr"`. Emits `dir="rtl"` ONLY when `dir === "rtl"` (omitted for ltr → byte-identical default).

- [ ] **Step 1: Write/adjust the failing tests**

In `apps/web/lib/jab/compose-site-emit.test.ts`, the two existing assertions (currently `expect(src).toMatch(/<html lang="en" id="jab-app">/)`) stay valid for the default call. Add a new describe block (near the existing app/layout.tsx tests):

```ts
describe("emitLayoutTsx — locale", () => {
  it("defaults to lang=en with no dir (byte-identical to the pre-locale output)", () => {
    const src = emitLayoutTsx("Site", null);
    expect(src).toContain('<html lang="en" id="jab-app">');
    expect(src).not.toContain("dir=");
  });

  it("emits a non-English lang and still omits dir for LTR", () => {
    const src = emitLayoutTsx("Site", null, [], "de", "ltr");
    expect(src).toContain('<html lang="de" id="jab-app">');
    expect(src).not.toContain("dir=");
  });

  it("emits dir=rtl for an RTL locale", () => {
    const src = emitLayoutTsx("Site", null, [], "ar", "rtl");
    expect(src).toContain('<html lang="ar" dir="rtl" id="jab-app">');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts -t "emitLayoutTsx — locale"`
Expected: FAIL — `emitLayoutTsx` ignores the extra args (no `lang="de"` / `dir="rtl"`).

- [ ] **Step 3: Implement**

In `apps/web/lib/jab/compose-site-emit.ts`, change `emitLayoutTsx`'s signature and the `<html>` line:

```ts
export function emitLayoutTsx(
  projectName: string,
  description: string | null,
  fontLinkHrefs: string[] = [],
  lang: string = "en",
  dir: "ltr" | "rtl" = "ltr",
): string {
  const safeName = JSON.stringify(projectName);
  const safeDescription = JSON.stringify(description ?? "Generated by JAB");
  // dir is emitted only for rtl — HTML defaults to ltr, so omitting it keeps an
  // English/LTR site's <html> byte-identical to the pre-locale output.
  const dirAttr = dir === "rtl" ? ' dir="rtl"' : "";
  const fontLinks = fontLinkHrefs.length
    ? // ...unchanged...
```

And the `<html>` line:

```ts
    <html lang="${lang}"${dirAttr} id="jab-app">
```

(Everything else in the function is unchanged — `id="jab-app"`, body, font links.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/compose-site-emit.test.ts`
Expected: PASS (new locale block + the existing two `lang="en" id="jab-app"` assertions still pass — default call is byte-identical).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/compose-site-emit.ts apps/web/lib/jab/compose-site-emit.test.ts
git commit -m "feat(locale): emitLayoutTsx accepts lang/dir (default en/ltr = byte-identical)"
```

---

### Task 3: Persist locale in BuildConfig + carry-forward

**Files:**
- Modify: `apps/web/lib/jab/build-config.ts`
- Test: `apps/web/lib/jab/build-config.test.ts`

**Interfaces:**
- Produces:
  - `BuildConfig` (both `full` and `edit` unions) gains `locale?: string` (raw WP locale, e.g. `"en_US"`).
  - `buildLocaleConfigPatch(locale: string | null | undefined): { locale?: string }`.
  - `CarriedSourceConfig` gains `locale?: string`; `carryForwardSourceConfig` extracts it.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/lib/jab/build-config.test.ts`:

```ts
import { buildLocaleConfigPatch, carryForwardSourceConfig } from "./build-config";

describe("buildLocaleConfigPatch", () => {
  it("returns { locale } for a non-empty locale", () => {
    expect(buildLocaleConfigPatch("en_US")).toEqual({ locale: "en_US" });
    expect(buildLocaleConfigPatch("ar")).toEqual({ locale: "ar" });
  });
  it("returns {} for null/undefined/empty (no key written)", () => {
    expect(buildLocaleConfigPatch(null)).toEqual({});
    expect(buildLocaleConfigPatch(undefined)).toEqual({});
    expect(buildLocaleConfigPatch("")).toEqual({});
    expect(buildLocaleConfigPatch("   ")).toEqual({});
  });
});

describe("carryForwardSourceConfig — locale", () => {
  it("carries a string locale", () => {
    expect(carryForwardSourceConfig({ front_page_slug: "home", locale: "de_DE" }).locale).toBe("de_DE");
  });
  it("omits locale when absent or non-string", () => {
    expect(carryForwardSourceConfig({ front_page_slug: "home" }).locale).toBeUndefined();
    expect(carryForwardSourceConfig({ front_page_slug: "home", locale: 5 }).locale).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/build-config.test.ts -t "locale"`
Expected: FAIL (functions don't exist / `locale` not extracted).

- [ ] **Step 3: Implement**

In `apps/web/lib/jab/build-config.ts`:

Add `locale?: string` to the `{ mode: "full" }` union and the `{ mode: "edit"; ... }` union:

```ts
export type BuildConfig =
  | { mode: "full"; locale?: string }
  | {
      mode: "edit";
      // ...existing fields...
      last_sync_watermark?: string;
      locale?: string;
    };
```

Add the patch builder (next to `buildFrontPageConfigPatch`):

```ts
/**
 * Patch for persisting the source WP locale into site_builds.config. Mirrors
 * buildFrontPageConfigPatch — returns {} (no key) for a blank locale so the
 * read-modify-write never writes an empty value.
 */
export function buildLocaleConfigPatch(
  locale: string | null | undefined,
): { locale?: string } {
  return locale && locale.trim().length > 0 ? { locale: locale.trim() } : {};
}
```

Add `locale` to `CarriedSourceConfig` and `carryForwardSourceConfig`:

```ts
export interface CarriedSourceConfig {
  front_page_slug: string | null;
  show_on_front?: "page" | "posts";
  last_sync_watermark?: string;
  locale?: string;
}
```

```ts
  if (typeof cfg.locale === "string" && cfg.locale.length > 0) {
    out.locale = cfg.locale;
  }
```

(Add `locale?: unknown;` to the `cfg` cast type inside `carryForwardSourceConfig` so the read typechecks.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/build-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/build-config.ts apps/web/lib/jab/build-config.test.ts
git commit -m "feat(locale): persist locale in BuildConfig + carry-forward"
```

---

### Task 4: Wire discovery (persist) + compose (apply)

**Files:**
- Modify: `apps/web/lib/inngest/functions/discover-site.ts`
- Modify: `apps/web/lib/inngest/functions/compose-site.ts`

**Interfaces:**
- Consumes: `buildLocaleConfigPatch` (`@/lib/jab/build-config`); `localeToBcp47`, `localeDir` (`@/lib/jab/locale`).
- Produces: no exported surface change — worker wiring only. Verified by `tsc` + full suite.

- [ ] **Step 1: Persist the locale at discovery**

In `apps/web/lib/inngest/functions/discover-site.ts`, import `buildLocaleConfigPatch` alongside `buildFrontPageConfigPatch`, then merge its patch into the same `site_builds.config` read-modify-write that persists the front-page config (around the existing `frontPageConfigPatch` / `persist-front-page-slug` step). Combine the patches so a single RMW writes both:

```ts
const localeConfigPatch = buildLocaleConfigPatch(siteManifest?.site?.locale ?? null);
const configPatch = { ...frontPageConfigPatch, ...localeConfigPatch };
```

Then guard + write on `configPatch` (replace the existing `frontPageConfigPatch`-keyed guard/RMW with `configPatch`):

```ts
if (Object.keys(configPatch).length > 0) {
  await step.run("persist-build-config", async () => {
    const supabase = createAdminClient();
    const { data: row } = await supabase
      .from("site_builds").select("config").eq("id", buildId)
      .single<{ config: Record<string, unknown> | null }>();
    const nextConfig = { ...(row?.config ?? {}), ...configPatch };
    const { error: writeErr } = await supabase
      .from("site_builds").update({ config: nextConfig }).eq("id", buildId);
    if (writeErr) throw new Error(`persist-build-config failed: ${writeErr.message}`);
  });
}
```

(Keep the existing step name if you prefer minimal churn — the key change is merging `localeConfigPatch` into the written object. `siteManifest` may be null on a manifest-fetch miss, so use optional chaining + the `?? null` fallback.)

- [ ] **Step 2: Apply the locale at compose**

In `apps/web/lib/inngest/functions/compose-site.ts`, import the helpers:

```ts
import { localeToBcp47, localeDir } from "@/lib/jab/locale";
```

Where `emitLayoutTsx` is called (the `emit-layout` step), derive `lang`/`dir` from the loaded `BuildConfig` and pass them:

```ts
const lang = localeToBcp47(config.locale);
const dir = localeDir(config.locale);
await step.run("emit-layout", () =>
  uploadToProject(buildId, "app/layout.tsx", emitLayoutTsx(project.name, description, fontLinkHrefs, lang, dir)),
);
```

(`config` is the `BuildConfig` already loaded by the `load-build-config` step; `config.locale` is `undefined` for pre-locale builds → `localeToBcp47` returns `"en"`, `localeDir` returns `"ltr"` → byte-identical.)

- [ ] **Step 3: Verify the whole app typechecks and the suite is green**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: no errors.

Run: `pnpm --filter @jab/web test`
Expected: full suite green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/inngest/functions/discover-site.ts apps/web/lib/inngest/functions/compose-site.ts
git commit -m "feat(locale): persist WP locale at discovery, apply lang/dir at compose"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md` (A9)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update fleet-gap A9**

Mark A9 PARTIAL: the deployed clone now emits `<html lang dir>` from the persisted WP locale (default-on, byte-identical for English/LTR, no migration). Remaining: the draft shell (`html-shell.ts` / `route.ts`) and the kit `scaffold.ts` still hardcode `lang="en"`; region is dropped (`en_US → en`); generated components use physical Tailwind classes, so `dir="rtl"` fixes text flow but not full layout mirroring. Reference this plan.

- [ ] **Step 2: Add a CLAUDE.md snapshot paragraph**

Describe the locale/RTL deployed-path support landing (persisted to `site_builds.config`, `localeToBcp47`/`localeDir`, threaded into `emitLayoutTsx`, default-on/byte-identical-for-English, no migration), and the documented residuals (draft + scaffold + region + RTL physical-class mirroring). Reference this plan.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md CLAUDE.md
git commit -m "docs(locale): record deployed-path locale/RTL support"
```

---

## Out of scope (documented follow-ups — A9 remains partially open)

- **Draft shell** (`lib/draft/html-shell.ts`, `app/draft/[projectId]/route.ts`) — both hardcode `lang="en"`. The draft is a transient preview; threading locale needs the draft data path to load `config.locale`. Per A9's "deployed-site only" scope.
- **Kit `scaffold.ts`** (`apps/web/lib/jab/scaffold.ts`, `packages/cli`) — the dev-owned starter layout. Devs rewrite it; lower value; separate caller chain.
- **Region preservation** — `en_US → en` drops region. `de-DE` / `pt-BR` precision is a follow-up; the language subtag covers SEO/screen-readers and RTL detection.
- **RTL layout mirroring** — generated components use physical Tailwind classes (`ml-4`, `pl-4`). `dir="rtl"` fixes text flow + is the standards-correct attribute, but full visual mirroring needs logical classes (`ms-4`, `ps-4`) — a generation-prompt follow-up.
```

