import "server-only";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
import type { ModelClient } from "./model-client";
import { validateTsx } from "./component-generator";
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

/**
 * Size cap for an emitted shell component (post code-fence strip).
 *
 * Originally 12KB based on a "typical" shell estimate. Bumped to 24KB after
 * validating against Two Roads (build 982f0d57): the high-fidelity footer
 * came in at 14.8KB — driven by 7 inline social SVG icons (Instagram /
 * Facebook / YouTube / TikTok, both Two Roads + Campus brands), 5-column
 * nav grid, 3 physical addresses, and a legal bar. The output had 0 TS
 * diagnostics — it was rejected purely on size, then replaced by the
 * deterministic fallback. That's a quality regression, not a safety win.
 *
 * 24KB is still well under the model's `max_tokens: 8192` output ceiling
 * (~32KB worst-case) and still flags runaway generations. Inline SVG path
 * strings gzip down to ~2KB total, so deployed size is unaffected.
 */
const MAX_SHELL_BYTES = 24_000;

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

  // Missing-input short-circuit: empty shellDom means no source DOM was
  // captured for this shell kind. Skip the LLM entirely and return the
  // deterministic fallback — same pattern as passthrough blocks in
  // component-generator.ts.
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
      console.warn(`[generate-shell] attempt ${attemptCount} over cap for ${kind} (${Buffer.byteLength(stripped, "utf8")} bytes)`);
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

  // Both attempts failed (bad TSX, size exceeded, or API errors).
  // Return the deterministic fallback but preserve accumulated token telemetry
  // so the DB records the cost even on failure.
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
  return text
    .replace(/^\s*```(?:tsx|ts|jsx|js)?\s*/i, "")
    .replace(/\s*```\s*$/i, "");
}
