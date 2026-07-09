# Patch Prose-Strip + Retry-Feedback Implementation Plan (Defect 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop chat/generation patches from failing with `parse errors: …(0): Unexpected keyword or identifier` when the LLM prepends prose or a decorated code fence, and make the patch retry actually able to self-correct by feeding the prior failure back into the second attempt.

**Architecture:** Two independent, additive changes. (1) `postprocessGeneratedTsx` gains a deterministic leading-non-code-preamble stripper as its FIRST step, and its fence stripper is generalized to catch fences carrying trailing text (```` ```tsx title=Foo.tsx ````). Both are byte-identical for already-clean output. (2) `patchUnitSource`'s 2-attempt loop builds the user prompt INSIDE the loop and appends the prior attempt's validation error to attempt 2 so the model gets a corrective signal instead of an identical re-roll.

**Tech Stack:** TypeScript, Vitest. Pure text transforms — no server-only, no LLM, no DB.

## Global Constraints

- `postprocessGeneratedTsx` is shared by BOTH the patch path (`patch-component.ts`) and the Phase B generator (`component-generator.ts:1206`, `:1332`). Any change must be byte-identical for already-clean output and must not regress the generator's existing tests.
- The preamble stripper must be CONSERVATIVE: trim ONLY a contiguous leading run of non-code lines, STOP at the first recognized code-start line, and NEVER scan into the body. Treat `//` and `/*` comment lines as valid code starts (do not strip a legitimate leading comment).
- `generated-tsx-postprocess.ts` is deliberately NOT `server-only` (imported under `tsx` by scripts) — do not add the directive.
- The patch loop is intentionally 2 attempts (low volume) — do not increase the attempt count; only add feedback to the existing second attempt.

---

### Task 1: Generalize fence stripping + add leading-preamble stripper to postprocess

**Files:**
- Modify: `apps/web/lib/ai/generated-tsx-postprocess.ts` (`stripCodeFences` at lines 59-64; `postprocessGeneratedTsx` pipeline at lines 181-197)
- Test: `apps/web/lib/ai/generated-tsx-postprocess.test.ts` (extend if it exists — check first)

**Interfaces:**
- Consumes: nothing new.
- Produces: `postprocessGeneratedTsx(source, { expectedExportName })` now additionally strips (a) a fence line carrying trailing text, and (b) a contiguous leading run of non-code prose lines before the first real code token. Signature unchanged.

- [ ] **Step 1: Check for the existing test file and read it**

Run: `cd apps/web && ls lib/ai/generated-tsx-postprocess.test.ts 2>&1 || echo "does not exist"`

If it exists, read it fully to match its style/fixtures. If not, you'll create it in Step 2.

- [ ] **Step 2: Write the failing tests**

Add to `apps/web/lib/ai/generated-tsx-postprocess.test.ts` (create with the standard vitest import header if absent). These assert the two new strip behaviors produce clean, export-correct output. Use a minimal valid component as the payload:

```typescript
import { describe, it, expect } from "vitest";
import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";

const VALID = `export function Foo() {\n  return <div>hi</div>;\n}\n`;

describe("postprocessGeneratedTsx — prose preamble + decorated fence stripping", () => {
  it("strips a leading prose preamble before the first code line", () => {
    const input = `Here is the modified component:\n\n${VALID}`;
    const out = postprocessGeneratedTsx(input, { expectedExportName: "Foo" });
    expect(out.trimStart().startsWith("export function Foo")).toBe(true);
    expect(out).not.toContain("Here is the modified component");
  });

  it("strips a multi-line prose preamble", () => {
    const input = `To change the heading, I updated the class.\nThe rest is unchanged.\n\n${VALID}`;
    const out = postprocessGeneratedTsx(input, { expectedExportName: "Foo" });
    expect(out.trimStart().startsWith("export function Foo")).toBe(true);
    expect(out).not.toContain("To change the heading");
  });

  it("strips a fence line that carries trailing text (```tsx title=Foo.tsx)", () => {
    const input = "```tsx title=Foo.tsx\n" + VALID + "```";
    const out = postprocessGeneratedTsx(input, { expectedExportName: "Foo" });
    expect(out).not.toContain("title=Foo.tsx");
    expect(out).not.toContain("```");
    expect(out.trimStart().startsWith("export function Foo")).toBe(true);
  });

  it("is byte-identical for already-clean input (no preamble, no fences)", () => {
    const out = postprocessGeneratedTsx(VALID, { expectedExportName: "Foo" });
    expect(out).toBe(VALID);
  });

  it("preserves a legitimate leading line comment (does not treat // as prose)", () => {
    const input = `// Foo renders the hero\n${VALID}`;
    const out = postprocessGeneratedTsx(input, { expectedExportName: "Foo" });
    expect(out.trimStart().startsWith("// Foo renders the hero")).toBe(true);
  });

  it("preserves a leading 'use client' directive as a code start", () => {
    const input = `"use client";\n${VALID}`;
    const out = postprocessGeneratedTsx(input, { expectedExportName: "Foo" });
    expect(out.trimStart().startsWith(`"use client"`)).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run lib/ai/generated-tsx-postprocess.test.ts -t "prose preamble"`
Expected: FAIL — the preamble tests fail (prose survives → output doesn't start with `export function Foo`), and the decorated-fence test fails (`title=Foo.tsx` survives). The "byte-identical", comment, and use-client tests should already PASS (they're guardrails against over-stripping).

- [ ] **Step 4: Implement the generalized fence strip + preamble strip**

In `apps/web/lib/ai/generated-tsx-postprocess.ts`, replace `stripCodeFences` (lines 59-64) with a version whose regex also matches a fence carrying trailing text, and add a new `stripLeadingNonCodePreamble` function right after it:

```typescript
function stripCodeFences(src: string): string {
  return src
    .split(/\r?\n/)
    // Matches a whole-line fence marker with an optional language tag AND
    // optional trailing text (e.g. ```tsx, ```typescript, ```tsx title=Foo.tsx, ```).
    // The trailing `.*` only applies to a line that STARTS with a fence marker,
    // so inline backticks inside JSX/strings are still untouched.
    .filter((line) => !/^\s*```.*$/.test(line))
    .join("\n");
}

/**
 * Regexes recognizing the first line of real TSX/TS the LLM should emit.
 * A component reliably begins with one of these. Anything before the first
 * matching line is an LLM prose lead-in ("Here is the updated component:")
 * and is dropped — but ONLY the contiguous leading run, never body content.
 * Comment lines (// and /*) count as code starts so a legitimate leading
 * comment is preserved.
 */
const CODE_START_RE =
  /^\s*(import\b|export\b|["']use client["']|\/\/|\/\*|@|const\b|let\b|function\b|type\b|interface\b|class\b|enum\b)/;

function stripLeadingNonCodePreamble(src: string): string {
  const lines = src.split(/\r?\n/);
  let i = 0;
  // Skip blank lines and non-code prose lines until the first recognized code
  // start. Stop immediately at that line — never scan past it into the body.
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (CODE_START_RE.test(line)) break;
    i++;
  }
  // If we consumed every line without finding a code start, return the source
  // unchanged — dropping everything would guarantee a downstream failure with
  // no signal; let ensureExportName/validateTsx produce the honest error.
  if (i >= lines.length) return src;
  return lines.slice(i).join("\n");
}
```

Then update `postprocessGeneratedTsx` (lines 181-197) to run the preamble strip FIRST, then the (now generalized) fence strip:

```typescript
export function postprocessGeneratedTsx(source: string, opts: PostprocessOptions): string {
  let out = source;

  // 0. Drop an LLM prose lead-in before the first real code line (e.g.
  //    "Here is the modified component:"). Conservative: only a contiguous
  //    leading run, stops at the first code start.
  out = stripLeadingNonCodePreamble(out);

  // 1. Strip code fences (incl. a fence line carrying trailing text)
  out = stripCodeFences(out);

  // 2. Rewrite BlockNode import paths
  out = rewriteBlockNodeImports(out);

  // 3. Ensure expected export name exists
  out = ensureExportName(out, opts.expectedExportName);

  // 4. Add "use client" if hooks are used and directive is absent
  out = ensureUseClient(out);

  return out;
}
```

Note on ordering: preamble strip runs BEFORE fence strip so that a ```` ```tsx ```` fence line (which IS a recognized non-code line for CODE_START_RE purposes? no — a fence line does NOT match CODE_START_RE) is handled correctly. Trace it: input ```` ```tsx\n export function… ````. `stripLeadingNonCodePreamble` sees line 0 = ```` ```tsx ````, which does not match CODE_START_RE, so it's treated as preamble and skipped; line 1 = `export function` matches → slice from there. So the fence is ALSO removed by the preamble strip in the leading position. The generalized `stripCodeFences` still runs to catch a TRAILING closing ```` ``` ```` fence (which the preamble strip never reaches). Both together handle open+close fences and decorated fences. Confirm this reasoning holds when you run the tests.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run lib/ai/generated-tsx-postprocess.test.ts`
Expected: All tests PASS (new + any pre-existing).

- [ ] **Step 6: Run the generator's own tests to confirm no regression**

Run: `cd apps/web && npx vitest run lib/ai/component-generator.test.ts lib/ai/patch-component.test.ts`
Expected: All PASS — the shared postprocess change must not break generation or patching.

- [ ] **Step 7: Commit**

```bash
cd apps/web
git add lib/ai/generated-tsx-postprocess.ts lib/ai/generated-tsx-postprocess.test.ts
git commit -m "fix(patch): strip LLM prose preamble + decorated fences before parse-check"
```

---

### Task 2: Feed the prior attempt's error into the patch retry

**Files:**
- Modify: `apps/web/lib/ai/patch-component.ts` (`patchUnitSource` loop at lines 132-187)
- Test: `apps/web/lib/ai/patch-component.test.ts`

**Interfaces:**
- Consumes: `PatchUnitOptions` (unchanged).
- Produces: on a failed first attempt, `patchUnitSource`'s second `client.generate` call receives a `userPrompt` that includes the first attempt's `lastError` and a corrective instruction. Byte-identical first-attempt prompt; only attempt 2 differs, and only after a failure.

- [ ] **Step 1: Read the existing patch-component.test.ts to match its mock-client pattern**

Run: `cd apps/web && ls lib/ai/patch-component.test.ts` then read it fully — note how it constructs a stub `ModelClient` (the `client.generate` mock) so your new test can capture the prompts passed to each call.

- [ ] **Step 2: Write the failing test**

Add a test asserting that when attempt 1 produces output that fails validation, attempt 2's `generate` call receives a user prompt containing the prior error. Use a stub client that returns bad TSX first, good TSX second, and records every call's args:

```typescript
describe("patchUnitSource — retry feeds back the prior error", () => {
  it("includes attempt-1's validation error in attempt-2's user prompt", async () => {
    const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
    let n = 0;
    const client = {
      generate: async (args: { systemPrompt: string; userPrompt: string }) => {
        calls.push(args);
        n++;
        // Attempt 1: unparseable garbage → validateTsx fails.
        // Attempt 2: a valid component with the right export.
        const text =
          n === 1
            ? "this is not valid tsx @@@ <<<"
            : "export function Foo() { return <div>ok</div>; }";
        return { text, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } };
      },
    } as unknown as import("./model-client").ModelClient;

    const result = await patchUnitSource({
      currentTsx: "export function Foo() { return <div>old</div>; }",
      guidance: "change the text to ok",
      exportName: "Foo",
      maxBytes: 10_000,
      client,
    });

    expect(result.ok).toBe(true);
    expect(calls.length).toBe(2);
    // Attempt 1's prompt has no feedback section.
    expect(calls[0].userPrompt).not.toContain("previous output failed");
    // Attempt 2's prompt carries the prior failure so the model can self-correct.
    expect(calls[1].userPrompt).toContain("previous output failed");
  });
});
```

Adjust the stub's `generate` return shape and the `ModelClient` import path to match whatever the existing tests in this file actually use (read them first — the `usage` shape and import must match the real `ModelClient` interface).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/web && npx vitest run lib/ai/patch-component.test.ts -t "retry feeds back"`
Expected: FAIL — `calls[1].userPrompt` does NOT contain "previous output failed" today (attempt 2 gets the identical prompt).

- [ ] **Step 4: Implement the retry feedback**

In `apps/web/lib/ai/patch-component.ts`, modify `patchUnitSource` (lines 132-187). Keep the `prompt` built once (its `.system` is stable), but build the per-attempt `userPrompt` inside the loop, appending `lastError` after a failed attempt:

```typescript
export async function patchUnitSource(opts: PatchUnitOptions): Promise<PatchResult> {
  const prompt = buildPatchPrompt({
    currentTsx: opts.currentTsx,
    guidance: opts.guidance,
    exportName: opts.exportName,
    themeClassNames: opts.themeClassNames,
    tokens: opts.tokens,
    sourceHosts: opts.sourceHosts,
  });
  const usage: GenerateUsage[] = [];
  let lastError = "no attempts ran";

  for (let attempt = 0; attempt < 2; attempt++) {
    // Attempt 1 uses the base user prompt. A retry appends the prior failure so
    // the model gets a corrective signal instead of an identical re-roll (the
    // #1 cause of doubled-cost guaranteed-identical failures).
    const userPrompt =
      attempt === 0
        ? prompt.user
        : `${prompt.user}\n\n## Your previous output failed validation with:\n${lastError}\n\nReturn ONLY the corrected raw TSX for the component — no prose, no markdown fences, no explanation. Keep the named export \`${opts.exportName}\`.`;

    const result = await opts.client.generate({
      systemPrompt: prompt.system,
      userPrompt,
    });
    usage.push(result.usage);

    let candidate: string;
    try {
      candidate = postprocessGeneratedTsx(result.text, { expectedExportName: opts.exportName });
    } catch (err) {
      lastError = `postprocess: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    if (opts.sourceHosts && opts.sourceHosts.length > 0) {
      candidate = rewriteWpOriginUrls(candidate, {
        sourceHosts: opts.sourceHosts,
        routePathMap: opts.routePathMap,
      });
    }
    if (Buffer.byteLength(candidate, "utf-8") > opts.maxBytes) {
      lastError = `output exceeds ${opts.maxBytes} bytes`;
      continue;
    }
    const errors = validateTsx(candidate, `${opts.exportName}.tsx`);
    if (errors.length > 0) {
      lastError = `parse errors: ${errors.slice(0, 3).join("; ")}`;
      continue;
    }
    return { ok: true, tsx: candidate, attempts: attempt + 1, usage };
  }
  return { ok: false, error: lastError, attempts: 2, usage };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/web && npx vitest run lib/ai/patch-component.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd apps/web
git add lib/ai/patch-component.ts lib/ai/patch-component.test.ts
git commit -m "fix(patch): feed the prior attempt's error into the retry so it can self-correct"
```

---

### Task 3: Full-suite verification

- [ ] **Step 1: Full suite**

Run: `cd apps/web && npx vitest run`
Expected: all pass.

- [ ] **Step 2: Full typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.
