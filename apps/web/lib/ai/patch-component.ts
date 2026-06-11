import "server-only";
import { validateTsx } from "./component-generator";
import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";
import type { ModelClient, GenerateUsage } from "./model-client";

/**
 * patch-component — the Live Draft edit primitive (spec §6.2.3). Unlike the
 * Phase B generator (which re-derives a component from DOM samples and can
 * silently lose earlier edits), this takes the CURRENT draft TSX as input and
 * asks for a minimal modification — iterative chat edits compound instead of
 * resetting. Same validation discipline as generation: postprocess → parse
 * check → size cap, two attempts.
 */
export interface PatchPromptInput {
  currentTsx: string;
  guidance: string;
  exportName: string;
}

export function buildPatchPrompt(input: PatchPromptInput): { system: string; user: string } {
  const system = `You are editing an existing React/Next.js component from a generated WordPress-clone site.

## Output contract
- Return ONLY the complete modified TypeScript/TSX source. No markdown fences. No prose.
- Keep the named export \`${input.exportName}\` and its exact props signature unchanged.
- Keep all imports as they are unless the edit requires removing one.
- Use Tailwind CSS classes for styling changes. No inline style objects unless a value is dynamic.
- Make the MINIMAL change that satisfies the instruction — do not refactor,
  reformat, rename, or "improve" anything the instruction doesn't ask for.
- Preserve all existing behavior outside the requested change.`;
  const user = `## Current source
${input.currentTsx.trim()}

## Edit instruction
${input.guidance.trim()}`;
  return { system, user };
}

export type PatchResult =
  | { ok: true; tsx: string; attempts: number; usage: GenerateUsage[] }
  | { ok: false; error: string; attempts: number; usage: GenerateUsage[] };

export interface PatchUnitOptions {
  currentTsx: string;
  guidance: string;
  exportName: string;
  /** MAX_COMPONENT_BYTES (10_000) for components, MAX_SHELL_BYTES (24_000) for shell. */
  maxBytes: number;
  client: ModelClient;
}

export async function patchUnitSource(opts: PatchUnitOptions): Promise<PatchResult> {
  const prompt = buildPatchPrompt(opts);
  const usage: GenerateUsage[] = [];
  let lastError = "no attempts ran";

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await opts.client.generate({
      systemPrompt: prompt.system,
      userPrompt: prompt.user,
      cacheSystemPrompt: attempt === 0,
    });
    usage.push(result.usage);

    let candidate: string;
    try {
      candidate = postprocessGeneratedTsx(result.text, { expectedExportName: opts.exportName });
    } catch (err) {
      lastError = `postprocess: ${err instanceof Error ? err.message : String(err)}`;
      continue;
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
