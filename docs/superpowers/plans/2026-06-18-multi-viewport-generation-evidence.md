# Multi-Viewport Generation Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed mobile (375px) responsive evidence to the component + shell generation prompts so generated components reflow correctly on phones, behind a default-off flag so the change is zero-risk to merge.

**Architecture:** The generation prompts today consume only the 1280px (desktop) computed styles; the 375px values are captured and persisted (`block_inventory.computed_styles.viewports["375"]`) but dropped at prompt time. This plan surfaces a **mobile-reflow delta** section in the component prompts (the responsive-relevant computed-style properties whose 375px value differs from 1280px) and a **responsive instruction** in the shell prompts. Both are gated by `JAB_RESPONSIVE_GEN=1`, read inside the two SHARED prompt builders (`buildComponentRequestParts`, `buildShellRequestParts`) so the sync and batch generation paths can't drift. The flag is folded into the component carry-forward hash (only when true) so flipping it on invalidates stale desktop-only components.

**Tech Stack:** TypeScript, Next.js App Router, vitest. Pure prompt-string builders (no model-client / image-pipeline changes — the mobile *screenshot* is a deferred follow-up).

## Global Constraints

- **Default-off flag.** `JAB_RESPONSIVE_GEN=1` enables mobile evidence. When unset/anything-else, every generated prompt is **byte-identical** to today, and the carry-forward hash is unchanged (no fleet-wide regen on deploy).
- **No image-pipeline change.** This plan adds NO screenshot. Only computed-style text (components) and an instruction (shell). The mobile *screenshot* for visual-tier blocks is a documented follow-up (it touches `model-client.ts` + both generation paths).
- **No DB migration.** `block_inventory.computed_styles` already carries all three viewports; no schema change.
- **Read the flag in the shared builders only.** `buildComponentRequestParts` (component-generator.ts) and `buildShellRequestParts` (generate-shell.ts) read `isResponsiveGenEnabled()`. Do NOT read it in the workers — both sync and batch paths call these shared builders, and reading it there is what keeps them from drifting.
- **Flag-gated content goes in the USER half, never the cached system prefix.** Keeps `COMPONENT_SYSTEM_CORE` / the shell cached prefix byte-stable and their prompt-cache keys intact. Do NOT modify `COMPONENT_SYSTEM_CORE` or `COMPONENT_PROMPT_VERSION`.
- **Commit trailer on every commit:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create** `apps/web/lib/ai/generation-flags.ts` (PURE, not server-only) — `isResponsiveGenEnabled(env?)`.
- **Create** `apps/web/lib/ai/generation-flags.test.ts`.
- **Modify** `apps/web/lib/ai/component-generator.ts` — `renderComputedStylesSection(cs, includeMobile)` gains a mobile-reflow delta subsection; `visualPrompt`/`standardPrompt` thread `includeMobile`; `buildComponentRequestParts` reads the flag.
- **Modify** `apps/web/lib/ai/component-generator.test.ts` — cover the mobile section + flag wiring.
- **Modify** `apps/web/lib/jab/component-carry-forward.ts` — fold `responsiveGen` into `componentEntryHash` (only when true).
- **Modify** `apps/web/lib/jab/component-carry-forward.test.ts` — hash unchanged when false, changes when true.
- **Modify** `apps/web/lib/inngest/functions/generate-components.ts` — pass `responsiveGen: isResponsiveGenEnabled()` into `componentEntryHash`.
- **Modify** `apps/web/lib/ai/shell-prompts.ts` — `ShellPromptInput.responsive`; `headerPrompt`/`footerPrompt` render a responsive section in the USER half when true.
- **Modify** `apps/web/lib/ai/shell-prompts.test.ts` — cover the responsive section.
- **Modify** `apps/web/lib/ai/generate-shell.ts` — `buildShellRequestParts` reads the flag → sets `promptInput.responsive`.
- **Modify** `apps/web/lib/ai/generate-shell.test.ts` — flag wiring.
- **Modify** docs (fleet-gap register A6, CLAUDE.md).

---

### Task 1: Responsive-gen flag (`generation-flags.ts`)

**Files:**
- Create: `apps/web/lib/ai/generation-flags.ts`
- Test: `apps/web/lib/ai/generation-flags.test.ts`

**Interfaces:**
- Produces: `isResponsiveGenEnabled(env?: NodeJS.ProcessEnv): boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/ai/generation-flags.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { isResponsiveGenEnabled } from "./generation-flags";

afterEach(() => vi.unstubAllEnvs());

describe("isResponsiveGenEnabled", () => {
  it("is true only for the exact '1' value", () => {
    expect(isResponsiveGenEnabled({ JAB_RESPONSIVE_GEN: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isResponsiveGenEnabled({ JAB_RESPONSIVE_GEN: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isResponsiveGenEnabled({ JAB_RESPONSIVE_GEN: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isResponsiveGenEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("JAB_RESPONSIVE_GEN", "1");
    expect(isResponsiveGenEnabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/generation-flags.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/ai/generation-flags.ts`:

```ts
// PURE module (deliberately NOT "server-only"): generation feature-flag
// readers. component-generator.ts and shell-prompts.ts/generate-shell.ts are
// also non-server-only (importable under tsx for operator scripts), so this
// must be too. Mirrors lib/ai/vision-prompt.ts's isVisionScoringEnabled.

/**
 * Default-off flag for multi-viewport (mobile, 375px) generation evidence.
 * When on, component prompts gain a mobile-reflow computed-style section and
 * shell prompts gain a responsive instruction. Exact "1" only.
 */
export function isResponsiveGenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JAB_RESPONSIVE_GEN === "1";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/generation-flags.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/generation-flags.ts apps/web/lib/ai/generation-flags.test.ts
git commit -m "feat(gen): JAB_RESPONSIVE_GEN flag reader (default-off)"
```

---

### Task 2: Mobile-reflow computed-style evidence in component prompts

**Files:**
- Modify: `apps/web/lib/ai/component-generator.ts`
- Test: `apps/web/lib/ai/component-generator.test.ts`

**Interfaces:**
- Consumes: `isResponsiveGenEnabled` (`./generation-flags`).
- Produces:
  - `renderComputedStylesSection(cs, includeMobile?: boolean)` — adds a mobile-reflow delta subsection when `includeMobile` and divergent 375px props exist.
  - `visualPrompt(entry, tokens, guidance?, sourceHost?, themeClassNames?, includeMobile?)` and `standardPrompt(...)` — new trailing optional `includeMobile` param (default `false`).
  - `buildComponentRequestParts` reads `isResponsiveGenEnabled()` and passes it as `includeMobile` to the visual/standard builders.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/lib/ai/component-generator.test.ts` (import `renderComputedStylesSection` is internal — test via `visualPrompt` and `buildComponentRequestParts`, which are exported). Append a new describe block:

```ts
import { vi, afterEach } from "vitest"; // ensure these are imported at top if not already

// ── mobile-reflow evidence (JAB_RESPONSIVE_GEN) ─────────────────────────
describe("mobile-reflow evidence", () => {
  afterEach(() => vi.unstubAllEnvs());

  const reflowEntry = () => ({
    ...makeVisualEntry(),
    computedStyles: {
      viewports: {
        "1280": { gridTemplateColumns: ["repeat(3, 1fr)"], fontSize: ["48px"], flexDirection: ["row"] },
        "375": { gridTemplateColumns: ["repeat(1, 1fr)"], fontSize: ["28px"], flexDirection: ["column"] },
      },
    },
  });

  it("omits the mobile section when includeMobile is false (byte-identical default)", () => {
    const p = visualPrompt(reflowEntry(), null);
    expect(p).not.toContain("Mobile reflow");
  });

  it("renders divergent 375px props as desktop→mobile deltas when includeMobile is true", () => {
    const p = visualPrompt(reflowEntry(), null, undefined, null, [], true);
    expect(p).toContain("Mobile reflow");
    expect(p).toContain("gridTemplateColumns: repeat(3, 1fr) (desktop) → repeat(1, 1fr) (mobile)");
    expect(p).toContain("fontSize: 48px (desktop) → 28px (mobile)");
    expect(p).toContain("flexDirection: row (desktop) → column (mobile)");
  });

  it("omits the mobile section when 375 values match desktop (no signal)", () => {
    const entry = {
      ...makeVisualEntry(),
      computedStyles: {
        viewports: {
          "1280": { fontSize: ["32px"], gridTemplateColumns: ["repeat(2, 1fr)"] },
          "375": { fontSize: ["32px"], gridTemplateColumns: ["repeat(2, 1fr)"] },
        },
      },
    };
    expect(visualPrompt(entry, null, undefined, null, [], true)).not.toContain("Mobile reflow");
  });

  it("omits the mobile section when no 375 viewport exists", () => {
    const entry = {
      ...makeVisualEntry(),
      computedStyles: { viewports: { "1280": { fontSize: ["32px"] } } },
    };
    expect(visualPrompt(entry, null, undefined, null, [], true)).not.toContain("Mobile reflow");
  });

  it("buildComponentRequestParts surfaces the mobile section only when JAB_RESPONSIVE_GEN=1", () => {
    const entry = reflowEntry();
    const off = buildComponentRequestParts({ entry, tokens: null });
    expect(off.userPrompt).not.toContain("Mobile reflow");

    vi.stubEnv("JAB_RESPONSIVE_GEN", "1");
    const on = buildComponentRequestParts({ entry, tokens: null });
    expect(on.userPrompt).toContain("Mobile reflow");
    // The cached system prefix is unaffected by the flag.
    expect(on.cachedSystemPrefix).toBe(off.cachedSystemPrefix);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/component-generator.test.ts -t "mobile-reflow"`
Expected: FAIL (no `includeMobile` param; no "Mobile reflow" output).

- [ ] **Step 3: Implement the mobile-delta renderer + thread the flag**

In `apps/web/lib/ai/component-generator.ts`, add the import near the top (after the existing imports):

```ts
import { isResponsiveGenEnabled } from "./generation-flags";
```

Add the responsive-prop ordering constant next to `PRIORITY_CSS_PROPS`:

```ts
/**
 * Layout-shifting properties, in mobile-reflow priority order. These are the
 * computed-style keys most likely to differ between desktop and mobile and
 * most actionable for responsive Tailwind. Keys match the discovery capture
 * (per-side padding/margin, camelCase). Used only for the mobile-delta section.
 */
const RESPONSIVE_CSS_PROPS = [
  "display",
  "flexDirection",
  "gridTemplateColumns",
  "gap",
  "fontSize",
  "paddingTop",
  "paddingLeft",
  "marginTop",
  "textAlign",
];

/**
 * Render the "## Mobile reflow" section: responsive-relevant computed-style
 * properties whose 375px (mobile) value DIFFERS from the 1280px (desktop, or
 * 768 fallback) value, as desktop→mobile deltas. Empty string when no 375
 * viewport, no desktop viewport, or nothing diverges. Capped at 8 deltas.
 */
function renderMobileDeltaSection(
  viewports: Record<string, Record<string, string[]>>,
): string {
  const desktop = viewports["1280"] ?? viewports["768"];
  const mobile = viewports["375"];
  if (!desktop || !mobile) return "";

  const deltas: Array<[string, string, string]> = [];
  const seen = new Set<string>();
  const consider = (prop: string) => {
    if (seen.has(prop) || deltas.length >= 8) return;
    const d = desktop[prop]?.[0];
    const m = mobile[prop]?.[0];
    if (d && m && d !== m) {
      deltas.push([prop, d, m]);
      seen.add(prop);
    }
  };
  for (const prop of RESPONSIVE_CSS_PROPS) consider(prop);
  for (const prop of Object.keys(mobile)) consider(prop);
  if (deltas.length === 0) return "";

  const lines = deltas.map(([p, d, m]) => `- ${p}: ${d} (desktop) → ${m} (mobile)`).join("\n");
  return `\n## Mobile reflow (375px vs 1280px, observed at runtime)
At the 375px mobile viewport these computed styles differ from desktop:
${lines}
Write mobile-first responsive Tailwind so the component reproduces the MOBILE
values as the base and the DESKTOP values at \`md:\`/\`lg:\`. E.g. a grid that
is 3 columns on desktop and 1 on mobile is \`grid-cols-1 md:grid-cols-3\`; a
heading that shrinks on mobile is \`text-2xl md:text-4xl\`; a row that stacks
on mobile is \`flex-col md:flex-row\`. Do not regress the desktop layout.
`;
}
```

Change the signature of `renderComputedStylesSection` to accept `includeMobile` and append the mobile section. Replace its final `return` so the desktop section is computed into a variable, then concatenated:

```ts
function renderComputedStylesSection(
  computedStyles: { viewports: Record<string, Record<string, string[]>> } | null | undefined,
  includeMobile = false,
): string {
  if (!computedStyles) return "";
  const vp = computedStyles.viewports?.["1280"] ?? computedStyles.viewports?.["768"];
  if (!vp || Object.keys(vp).length === 0) return "";
  const ordered: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const prop of PRIORITY_CSS_PROPS) {
    if (vp[prop]?.[0]) {
      ordered.push([prop, vp[prop][0]]);
      seen.add(prop);
    }
  }
  for (const [prop, values] of Object.entries(vp)) {
    if (ordered.length >= 8) break;
    if (seen.has(prop)) continue;
    if (values[0]) ordered.push([prop, values[0]]);
  }
  if (ordered.length === 0) return "";
  const lines = ordered.map(([prop, val]) => `- ${prop}: ${val}`).join("\n");
  const desktopSection = `\n## Computed style hints (desktop, observed at runtime)
${lines}
These are real getComputedStyle values from the source site's rendered DOM.
Use them as concrete targets for your Tailwind classes (e.g. fontSize "32px"
→ \`text-3xl\` or similar). The screenshot shows the result; these values
tell you the underlying CSS.
`;
  const mobileSection = includeMobile
    ? renderMobileDeltaSection(computedStyles.viewports ?? {})
    : "";
  return desktopSection + mobileSection;
}
```

Thread `includeMobile` through `visualPrompt` and `standardPrompt`. For `visualPrompt`, change the signature and the `renderComputedStylesSection` call:

```ts
export function visualPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null, guidance?: string, sourceHost?: string | null, themeClassNames?: string[], includeMobile = false): string {
  // ...unchanged up to:
  const stylesSection = renderComputedStylesSection(entry.computedStyles, includeMobile);
  // ...rest unchanged
```

For `standardPrompt`, identically:

```ts
export function standardPrompt(entry: EnrichedInventoryEntry, tokens: ThemeJsonTokens | null, guidance?: string, sourceHost?: string | null, themeClassNames?: string[], includeMobile = false): string {
  // ...unchanged up to:
  const stylesSection = renderComputedStylesSection(entry.computedStyles, includeMobile);
  // ...rest unchanged
```

In `buildComponentRequestParts`, read the flag and pass it to the visual/standard branches (cpt_template/acf_flex do not render computed styles, so they are unchanged):

```ts
export function buildComponentRequestParts(opts: GenerateComponentOptions): ComponentRequestParts {
  const { entry, tokens } = opts;
  const guidance = opts.guidance ?? undefined;
  const sourceHost = opts.sourceHosts?.[0] ?? null;
  const themeClassNames = opts.themeClassNames ?? [];
  // Read in the SHARED builder so sync (generateComponent) and batch
  // (component-batch.ts) paths cannot diverge. Flag-gated content lands in the
  // USER half only (visual/standard prompts), never the cached system prefix.
  const includeMobile = isResponsiveGenEnabled();

  let combinedPrompt: string;
  if (entry.kind === "cpt_template") {
    combinedPrompt = cptTemplatePrompt(entry, tokens, guidance, sourceHost, themeClassNames);
  } else if (entry.kind === "acf_flex") {
    combinedPrompt = acfFlexPrompt(entry, tokens, guidance, opts.dynamicList, sourceHost, themeClassNames);
  } else if (entry.tier === "visual") {
    combinedPrompt = visualPrompt(entry, tokens, guidance, sourceHost, themeClassNames, includeMobile);
  } else if (entry.tier === "standard") {
    combinedPrompt = standardPrompt(entry, tokens, guidance, sourceHost, themeClassNames, includeMobile);
  } else {
    combinedPrompt = trivialPrompt(entry, tokens, guidance, sourceHost, themeClassNames);
  }
  // ...rest unchanged (split on "\n\nUSER:\n", cachedSystemPrefix logic)
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/component-generator.test.ts`
Expected: PASS (new mobile-reflow block + all existing tests — default-off keeps them byte-identical).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/component-generator.ts apps/web/lib/ai/component-generator.test.ts
git commit -m "feat(gen): mobile-reflow computed-style evidence in component prompts (flag-gated)"
```

---

### Task 3: Fold the flag into the component carry-forward hash

**Files:**
- Modify: `apps/web/lib/jab/component-carry-forward.ts`
- Modify: `apps/web/lib/inngest/functions/generate-components.ts`
- Test: `apps/web/lib/jab/component-carry-forward.test.ts`

**Interfaces:**
- Consumes: `isResponsiveGenEnabled` (`@/lib/ai/generation-flags`) in the worker.
- Produces: `ComponentEntryHashInput` gains optional `responsiveGen?: boolean`; `componentEntryHash` folds it into the `attrSamples` composite ONLY when true (off → hash byte-identical to today).

- [ ] **Step 1: Write the failing test**

Add to the existing `describe("componentEntryHash", ...)` block in `apps/web/lib/jab/component-carry-forward.test.ts` (it already defines a fixture named `ENTRY`):

```ts
  it("responsiveGen: hash is byte-identical when false or omitted (default path)", () => {
    const omitted = componentEntryHash(ENTRY);
    const explicitFalse = componentEntryHash({ ...ENTRY, responsiveGen: false });
    expect(explicitFalse).toBe(omitted);
  });

  it("responsiveGen: hash CHANGES when true (flipping the flag invalidates carried components)", () => {
    const off = componentEntryHash(ENTRY);
    const on = componentEntryHash({ ...ENTRY, responsiveGen: true });
    expect(on).not.toBe(off);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/component-carry-forward.test.ts -t "responsiveGen"`
Expected: FAIL (the field doesn't change the hash yet, or `responsiveGen` is not on the type).

- [ ] **Step 3: Implement**

In `apps/web/lib/jab/component-carry-forward.ts`, add `responsiveGen` to `ComponentEntryHashInput`:

```ts
export interface ComponentEntryHashInput {
  blockName: string | null;
  tier: string;
  model: string;
  promptVersion: number;
  attrSamples: unknown;
  occurrenceCount: number;
  pageSlugs: string[];
  spec: unknown;
  dynamicList: unknown;
  domSample: string | null;
  computedStyles: unknown;
  sourceHost: string | null;
  screenshotSha256: string | null;
  tokens: unknown;
  /**
   * When true, the prompt rendered the mobile-reflow section (JAB_RESPONSIVE_GEN).
   * Folded into the hash ONLY when true so flipping the flag on invalidates
   * stale desktop-only carried components; omitting it (off, the default) keeps
   * the hash byte-identical to pre-flag builds — no fleet-wide regen on deploy.
   */
  responsiveGen?: boolean;
}
```

In `componentEntryHash`, fold it into the `attrSamples` composite only when true:

```ts
    attrSamples: {
      samples:
        input.tier === "trivial" && Array.isArray(input.attrSamples) && input.attrSamples.length > 0
          ? [input.attrSamples[0]]
          : input.attrSamples,
      spec: input.spec ?? null,
      dynamicList: input.dynamicList ?? null,
      occurrenceCount: input.occurrenceCount,
      pageSlugsTop5: input.pageSlugs.slice(0, 5),
      // Spread only when true so the off-path hash is byte-identical to before.
      ...(input.responsiveGen ? { responsiveGen: true } : {}),
    },
```

In `apps/web/lib/inngest/functions/generate-components.ts`, add the import and pass the flag where `componentEntryHash` is called (the `promptVersion: COMPONENT_PROMPT_VERSION` site around line 406):

```ts
import { isResponsiveGenEnabled } from "@/lib/ai/generation-flags";
```

```ts
            promptVersion: COMPONENT_PROMPT_VERSION,
            responsiveGen: isResponsiveGenEnabled(),
```

(Insert `responsiveGen: isResponsiveGenEnabled()` into the object literal passed to `componentEntryHash`. If the call uses `componentEntryHash({ ...entry-derived fields, promptVersion: COMPONENT_PROMPT_VERSION })`, add the line adjacent to `promptVersion`.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/jab/component-carry-forward.test.ts`
Expected: PASS (new responsiveGen block + all existing hash tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/jab/component-carry-forward.ts apps/web/lib/jab/component-carry-forward.test.ts apps/web/lib/inngest/functions/generate-components.ts
git commit -m "feat(gen): fold responsiveGen into carry-forward hash (only when true)"
```

---

### Task 4: Responsive instruction in shell prompts

**Files:**
- Modify: `apps/web/lib/ai/shell-prompts.ts`
- Modify: `apps/web/lib/ai/generate-shell.ts`
- Test: `apps/web/lib/ai/shell-prompts.test.ts`, `apps/web/lib/ai/generate-shell.test.ts`

**Interfaces:**
- Consumes: `isResponsiveGenEnabled` (`./generation-flags`) in `buildShellRequestParts`.
- Produces: `ShellPromptInput.responsive?: boolean`; `headerPrompt`/`footerPrompt` render a responsive section in the USER half when `responsive` is true.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/lib/ai/shell-prompts.test.ts`:

```ts
describe("responsive shell instruction", () => {
  const base = {
    shellDom: "<header><nav><a href='/'>Home</a><a href='/about'>About</a></nav></header>",
    themeTokens: null,
    menu: null,
    logoUrl: null,
    siteName: "Test Site",
    siteDescription: null,
  };

  it("omits the responsive section by default (byte-identical)", () => {
    expect(headerPrompt(base).user).not.toContain("Responsive");
    expect(footerPrompt(base).user).not.toContain("Responsive");
  });

  it("adds a nav-collapse instruction to the header when responsive is true", () => {
    const u = headerPrompt({ ...base, responsive: true }).user;
    expect(u).toContain("Responsive");
    expect(u.toLowerCase()).toMatch(/mobile|hamburger|toggle|collapse/);
    expect(u).toContain("md:");
  });

  it("adds a stack-on-mobile instruction to the footer when responsive is true", () => {
    const u = footerPrompt({ ...base, responsive: true }).user;
    expect(u).toContain("Responsive");
    expect(u.toLowerCase()).toMatch(/stack|column|mobile/);
  });
});
```

Add to `apps/web/lib/ai/generate-shell.test.ts`:

```ts
import { vi, afterEach } from "vitest"; // ensure imported at top
// ...
describe("buildShellRequestParts — responsive flag", () => {
  afterEach(() => vi.unstubAllEnvs());
  const opts = {
    kind: "header" as const,
    shellDom: "<header><nav><a href='/'>Home</a></nav></header>",
    themeTokens: null,
    menu: null,
    logoUrl: null,
    siteName: "Test Site",
    siteDescription: null,
    client: { generate: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, stopReason: "end_turn" as const, model: "m" }) },
  };

  it("omits the responsive section when JAB_RESPONSIVE_GEN is unset", () => {
    const parts = buildShellRequestParts(opts)!;
    expect(parts.userPrompt).not.toContain("Responsive");
  });

  it("includes the responsive section when JAB_RESPONSIVE_GEN=1", () => {
    vi.stubEnv("JAB_RESPONSIVE_GEN", "1");
    const parts = buildShellRequestParts(opts)!;
    expect(parts.userPrompt).toContain("Responsive");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/shell-prompts.test.ts lib/ai/generate-shell.test.ts -t "esponsive"`
Expected: FAIL (no `responsive` field; no "Responsive" output).

- [ ] **Step 3: Implement**

In `apps/web/lib/ai/shell-prompts.ts`, add `responsive` to `ShellPromptInput`:

```ts
  /** Source-WP hostname; when set, the prompt declares its URLs internal. */
  sourceHost?: string | null;
  /**
   * When true (JAB_RESPONSIVE_GEN), append a responsive instruction to the
   * USER half: nav-collapse for the header, stack-on-mobile for the footer.
   * Shell capture has no per-viewport computed styles or screenshot, so this
   * is a textual instruction only.
   */
  responsive?: boolean;
```

Add the renderer (near `renderShellGuidanceSection`):

```ts
function renderResponsiveSection(kind: "header" | "footer", responsive: boolean | undefined): string {
  if (!responsive) return "";
  if (kind === "header") {
    return `\n## Responsive requirement (mobile)
The source nav must remain usable on a 375px phone. Emit a responsive header:
show the full horizontal nav at \`md:\` and up, and BELOW \`md\` collapse it to
a toggle button (a hamburger \`<button>\`) that reveals the links. A \`useState\`
toggle is permitted (the only allowed hook); keep all link labels/hrefs from
the source — do not drop nav items on mobile, only restyle their container.
`;
  }
  return `\n## Responsive requirement (mobile)
On a 375px phone the footer must stack: multi-column footer layouts collapse to
a single column (\`grid-cols-1 md:grid-cols-N\` or \`flex-col md:flex-row\`).
Keep every column's content; only change the layout at the \`md:\` breakpoint.
`;
}
```

Render it in `headerPrompt` and `footerPrompt`, inserted into the USER half (before the final "Generate the ... DOM below" line is fine; place it after the guidance section). For `headerPrompt`:

```ts
export function headerPrompt(input: ShellPromptInput): ShellPromptParts {
  const system = buildShellSystem(input);
  const colors = renderShellColorsSection(input.shellColors);
  const logo = input.logoUrl ? `## Logo\n${input.logoUrl}\n` : "";
  const guidanceSection = renderShellGuidanceSection(input.guidance);
  const responsiveSection = renderResponsiveSection("header", input.responsive);
  const dom = sanitizeShellDom(input.shellDom, SHELL_DOM_PROMPT_MAX_BYTES);
  const user = `${colors}${logo}## Site identity
Name: ${input.siteName}
Description: ${input.siteDescription ?? "(none)"}

## Required signature
\`\`\`tsx
export function Header() { ... }
\`\`\`
${guidanceSection}${responsiveSection}Generate the Header component matching the structure of the source header DOM below (rendered HTML from the WP site, sanitized).

## Source header DOM
\`\`\`html
${dom}
\`\`\``;
  return { system, user };
}
```

For `footerPrompt`, identically add `const responsiveSection = renderResponsiveSection("footer", input.responsive);` and insert `${responsiveSection}` after `${guidanceSection}`.

In `apps/web/lib/ai/generate-shell.ts`, add the import:

```ts
import { isResponsiveGenEnabled } from "./generation-flags";
```

In `buildShellRequestParts`, read the flag and add it to `promptInput`:

```ts
  const promptInput = {
    shellDom: opts.shellDom,
    themeTokens: opts.themeTokens,
    themeClassNames: opts.themeClassNames,
    shellColors: opts.shellColors,
    menu: opts.menu,
    logoUrl: opts.logoUrl,
    siteName: opts.siteName,
    siteDescription: opts.siteDescription,
    guidance: opts.guidance,
    sourceHost: opts.sourceHost,
    // Read in the SHARED builder so sync + batch shell paths cannot diverge.
    responsive: isResponsiveGenEnabled(),
  };
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @jab/web exec vitest run lib/ai/shell-prompts.test.ts lib/ai/generate-shell.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the whole app typechecks and the suite is green**

Run: `pnpm --filter @jab/web exec tsc --noEmit`
Expected: no errors.

Run: `pnpm --filter @jab/web test`
Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/ai/shell-prompts.ts apps/web/lib/ai/generate-shell.ts apps/web/lib/ai/shell-prompts.test.ts apps/web/lib/ai/generate-shell.test.ts
git commit -m "feat(gen): responsive instruction in shell prompts (flag-gated)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md` (A6)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update fleet-gap A6**

In `docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md`, update the A6 entry: the generation half is now PARTIAL — mobile computed-style evidence (component prompts) + responsive instruction (shell prompts) shipped behind `JAB_RESPONSIVE_GEN=1` (default-off). The remaining open generation-half items are: the mobile **screenshot** for visual-tier blocks (touches model-client + both gen paths) and **768/tablet** evidence. Reference this plan.

- [ ] **Step 2: Add a CLAUDE.md snapshot paragraph**

Add a short paragraph to the "Current state" snapshot describing the multi-viewport generation evidence landing behind `JAB_RESPONSIVE_GEN=1` (default-off): mobile-reflow computed-style deltas in component prompts + a responsive instruction in shell prompts, read in the shared builders, folded into the carry-forward hash only when on; no migration; mobile screenshot deferred. Reference this plan.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-16-jab-fleet-gap-register.md CLAUDE.md
git commit -m "docs(gen): record multi-viewport generation evidence behind JAB_RESPONSIVE_GEN"
```

---

## Validation (operator, post-merge — gate before default-on)

The flag is default-off, so merge is zero-risk. Before flipping `JAB_RESPONSIVE_GEN` on by default, validate against one real build (worker host is a prod build reading `.env.local` — see saas-worker-host-prod-build):

1. Set `JAB_RESPONSIVE_GEN=1` in `apps/web/.env.local`; `pnpm build` + `pnpm start` with `INNGEST_DEV=1` (rebuild required).
2. Trigger a CLEAN Two Roads rebuild (a clean build, not incremental — flipping the flag invalidates the carry-forward hash, but a clean build is the cleanest validation).
3. Confirm generated component prompts include "Mobile reflow" deltas for blocks that reflow, and the Header emits a responsive nav (full links at md:+, a mobile toggle below).
4. On the build review screen, confirm the **mobile (375)** fidelity thumbnails/scores improve vs a baseline build, and that **desktop (1280)** fidelity does NOT regress (the canonical score must hold).

**Note — shell reuse bypasses the flag.** The component carry-forward hash folds `responsiveGen` (so flipping the flag invalidates carried visual/standard components), but shell reuse is gated by `shouldReuseShell` (`JAB_SKIP_SHELL_REGEN` / edit-build clones / artifact-exists), which is NOT hash-based. So a build that reuses its shell (skip-regen or an edit-build clone) will keep the old non-responsive `Header.tsx`/`Footer.tsx` even with the flag on. Use a **clean rebuild** (the step above) to pick up the shell responsive instruction. This matches the pre-existing shell-reuse-vs-prompt-drift behavior for guidance/prompt-version changes.

## Out of scope (documented follow-ups — A6 remains partially open)

- **Mobile screenshot for visual-tier blocks.** Threading the 375 screenshot as a second image touches `model-client.ts` (a second image block + label) and both generation paths (sync `generate-components.ts` screenshot load + batch `component-batch.ts`/`batch-client.ts`). Separable; the computed-style deltas deliver most of the responsive signal at zero image-token cost.
- **768/tablet evidence.** This plan surfaces only 375 (mobile) deltas — the same viewport the fidelity gate scores. 768 rarely diverges from desktop in ways 375 doesn't already reveal.
- **Shell mobile evidence.** Shell capture has no per-viewport computed styles or screenshot, so the shell gets a textual responsive instruction only. Capturing shell DOM/computed-styles at 375 is a larger follow-up.
- **Default-on.** Gated on the live validation above.
```

