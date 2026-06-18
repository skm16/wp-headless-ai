import "server-only";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
import { MAX_TOKENS_BY_TIER, modelConfigForTier, type GenerateUsage, type ModelClient } from "./model-client";
import type { BatchRequestItem, BatchResultItem } from "./batch-client";
import { validateTsx, buildRetryUserSuffix, type GenerationFailureKind } from "./component-generator";
import { classifyAiError, isRetryableAiFailure } from "./errors";
import {
  headerPrompt,
  footerPrompt,
  shellDeterministicFallback,
  shouldCacheShellPrefix,
  MAX_SHELL_BYTES,
  type ShellMenu,
} from "./shell-prompts";
import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";
import { rewriteWpOriginUrls } from "@/lib/jab/rewrite-origin-links";
import { isResponsiveGenEnabled } from "./generation-flags";

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

export interface GenerateShellOptions {
  kind: "header" | "footer";
  shellDom: string;
  themeTokens: ThemeJsonTokens | null;
  themeClassNames?: string[];
  menu: ShellMenu | null;
  logoUrl: string | null;
  siteName: string;
  siteDescription: string | null;
  /** Computed (rendered) colors of this shell's root, captured in discovery. */
  shellColors?: { backgroundColor?: string; color?: string } | null;
  client: ModelClient;
  guidance?: string;
  /** Source-WP host variants; when set, generated TSX gets origin-stripped. */
  sourceHosts?: string[];
  /** sourcePathname → clone route_path overrides (see rewrite-origin-links). */
  routePathMap?: Record<string, string>;
  /** Primary source-WP hostname; when set, the LLM prompt declares its URLs internal. */
  sourceHost?: string | null;
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
  /** Why the loop fell back (null on success / skipped). Persisted to shell_generations.failure_kind. */
  failureKind: GenerationFailureKind | null;
}

export interface ShellRequestParts {
  cachedSystemPrefix: string | undefined;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Pure prompt-parts builder shared by sync generateShell and the batch
 * ride-along. Returns null for empty shellDom (the sync short-circuit emits
 * the deterministic fallback for that case). MUST stay the single place the
 * shell prompt split is computed — drift here would make batch shells differ
 * from sync shells for identical inputs.
 */
export function buildShellRequestParts(opts: GenerateShellOptions): ShellRequestParts | null {
  if (!opts.shellDom || opts.shellDom.trim().length === 0) return null;

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
  const built = opts.kind === "header" ? headerPrompt(promptInput) : footerPrompt(promptInput);

  // Caching decision at build time: the stable half (rules + tokens + theme
  // classes + menu) only clears Sonnet's 2048-token minimum when large
  // enough. When cached, the second (uncached) system block must still be
  // non-empty — it carries the per-kind instruction line. Header and footer
  // share a byte-identical stable half, and compose-site runs them
  // sequentially, so the footer call reads the header call's cache write.
  const useCachedPrefix = shouldCacheShellPrefix(built.system);
  const cachedSystemPrefix = useCachedPrefix ? built.system : undefined;
  const systemPrompt = useCachedPrefix
    ? `Generate the site ${opts.kind} chrome component per the contract in the cached system block.`
    : built.system;

  return { cachedSystemPrefix, systemPrompt, userPrompt: built.user };
}

export async function generateShell(opts: GenerateShellOptions): Promise<GeneratedShell> {
  const { kind, client, menu, siteName } = opts;

  // Origin rewriter — applied at every TSX exit so generated nav links stay
  // on the clone regardless of which path produced the TSX.
  const relink = (tsx: string): string =>
    opts.sourceHosts && opts.sourceHosts.length > 0
      ? rewriteWpOriginUrls(tsx, { sourceHosts: opts.sourceHosts, routePathMap: opts.routePathMap })
      : tsx;

  // Missing-input short-circuit: empty shellDom means no source DOM was
  // captured for this shell kind (buildShellRequestParts returns null for
  // exactly that case). Skip the LLM entirely and return the deterministic
  // fallback — same pattern as passthrough blocks in component-generator.ts.
  const parts = buildShellRequestParts(opts);
  if (!parts) {
    return {
      shellKind: kind,
      tsx: relink(shellDeterministicFallback(kind, menu, siteName)),
      compileStatus: "skipped",
      compileAttemptCount: 0,
      modelUsed: null,
      providerUsed: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      failureKind: null,
    };
  }

  const { cachedSystemPrefix, systemPrompt, userPrompt: baseUserPrompt } = parts;
  const baseMaxTokens = MAX_TOKENS_BY_TIER.visual; // shell client is modelClientForTier("visual") — compose-site.ts

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let attemptCount = 0;
  let failureKind: GenerationFailureKind | null = null;
  let modelUsed: string | null = null;
  let retryErrors: string[] = [];
  let retryOutputTail = "";
  let maxTokensOverride: number | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    attemptCount++;
    const userPrompt =
      attempt === 0 || retryErrors.length === 0
        ? baseUserPrompt
        : `${baseUserPrompt}\n${buildRetryUserSuffix(retryErrors, retryOutputTail)}`;

    let result: Awaited<ReturnType<typeof client.generate>>;
    try {
      result = await client.generate({
        cachedSystemPrefix,
        systemPrompt,
        userPrompt,
        ...(maxTokensOverride !== undefined ? { maxTokens: maxTokensOverride } : {}),
      });
    } catch (err) {
      const errKind = classifyAiError(err);
      failureKind = errKind;
      console.warn(`[generate-shell] attempt ${attemptCount} API error (${errKind}) for ${kind}:`, err);
      if (!isRetryableAiFailure(errKind)) break; // 400/401-class: a second identical call is doomed
      retryErrors = []; // transient failure: identical retry is correct
      continue;
    }

    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    cacheReadTokens += result.usage.cacheReadTokens;
    cacheCreationTokens += result.usage.cacheCreationTokens;
    modelUsed = result.model;

    if (result.stopReason === "max_tokens") {
      failureKind = "max_tokens";
      console.warn(`[generate-shell] attempt ${attemptCount} hit max_tokens for ${kind} — output truncated at ${maxTokensOverride ?? baseMaxTokens} tokens`);
      if (attempt === 0) {
        maxTokensOverride = Math.min(16_000, Math.ceil(baseMaxTokens * 1.5));
        retryErrors = [
          "Previous attempt hit the max_tokens output limit and was truncated mid-file. Emit the COMPLETE component more concisely: shorter SVG paths, fewer wrapper elements, no comments.",
        ];
        retryOutputTail = result.text.slice(-500);
        continue;
      }
      break;
    }

    const expectedName = kind === "header" ? "Header" : "Footer";
    let stripped: string;
    try {
      stripped = postprocessGeneratedTsx(result.text.trim(), { expectedExportName: expectedName });
    } catch (err) {
      failureKind = "postprocess";
      console.warn(`[generate-shell] attempt ${attemptCount} postprocess failed for ${kind}:`, err);
      retryErrors = [err instanceof Error ? err.message : String(err)];
      retryOutputTail = result.text.slice(-500);
      continue;
    }
    // Rewrite source-origin URLs to root-relative paths BEFORE the byte-size
    // cap check — rewriting only shortens output, so the cap should judge the
    // final deployed artifact, not the pre-rewrite intermediate.
    stripped = relink(stripped);
    if (Buffer.byteLength(stripped, "utf8") > MAX_SHELL_BYTES) {
      failureKind = "over_cap";
      const bytes = Buffer.byteLength(stripped, "utf8");
      console.warn(`[generate-shell] attempt ${attemptCount} over cap for ${kind} (${bytes} bytes)`);
      retryErrors = [
        `Output was ${bytes} bytes — over the ${MAX_SHELL_BYTES}-byte cap. Emit a tighter component: shorter inline SVGs, fewer repeated class lists.`,
      ];
      retryOutputTail = stripped.slice(-500);
      continue;
    }
    const fileName = kind === "header" ? "Header.tsx" : "Footer.tsx";
    const errors = validateTsx(stripped, fileName);
    if (errors.length > 0) {
      failureKind = "invalid_tsx";
      console.warn(`[generate-shell] attempt ${attemptCount} TSX validation failed for ${kind}:`, errors.slice(0, 3));
      retryErrors = errors.slice(0, 3);
      retryOutputTail = stripped.slice(-500);
      continue;
    }

    return {
      shellKind: kind,
      tsx: stripped,
      compileStatus: "ok",
      compileAttemptCount: attemptCount,
      modelUsed,
      providerUsed: "anthropic",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      failureKind: null,
    };
  }

  // Both attempts failed (bad TSX, size exceeded, truncation, or API errors).
  // Return the deterministic fallback but preserve accumulated token telemetry
  // AND the ground truth of what (if anything) answered: modelUsed stays null
  // when zero API responses arrived — the failure row must never attribute
  // cost to a model that was never reached (audit generate-shell #6).
  return {
    shellKind: kind,
    tsx: relink(shellDeterministicFallback(kind, menu, siteName)),
    compileStatus: "failed",
    compileAttemptCount: attemptCount,
    modelUsed,
    providerUsed: modelUsed ? "anthropic" : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    failureKind: failureKind ?? "unknown",
  };
}

/** Shell entry for a Message Batch. Shells run on the visual-tier model config. */
export function buildShellBatchItem(
  opts: GenerateShellOptions,
  customId: string,
): BatchRequestItem | null {
  const parts = buildShellRequestParts(opts);
  if (!parts) return null;
  const cfg = modelConfigForTier("visual");
  return {
    customId,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    cachedSystemPrefix: parts.cachedSystemPrefix,
    system: parts.systemPrompt,
    user: parts.userPrompt,
  };
}

/**
 * Batch twin of generateShell's per-attempt body (postprocess → relink →
 * byte cap → validate). Returns null on ANY failure — the caller falls back
 * to sync generateShell, which carries the corrective retry; merge the
 * wasted batch spend in via mergeShellUsage.
 */
export function finalizeShellBatchResult(
  opts: GenerateShellOptions,
  result: BatchResultItem,
): GeneratedShell | null {
  if (!result.ok) return null;
  if (result.stopReason === "max_tokens") return null;

  const relink = (tsx: string): string =>
    opts.sourceHosts && opts.sourceHosts.length > 0
      ? rewriteWpOriginUrls(tsx, { sourceHosts: opts.sourceHosts, routePathMap: opts.routePathMap })
      : tsx;

  const expectedName = opts.kind === "header" ? "Header" : "Footer";
  let stripped: string;
  try {
    stripped = postprocessGeneratedTsx(result.text.trim(), { expectedExportName: expectedName });
  } catch {
    return null;
  }
  stripped = relink(stripped);
  if (Buffer.byteLength(stripped, "utf8") > MAX_SHELL_BYTES) return null;
  if (validateTsx(stripped, `${expectedName}.tsx`).length > 0) return null;

  return {
    shellKind: opts.kind,
    tsx: stripped,
    compileStatus: "ok",
    compileAttemptCount: 1,
    modelUsed: result.model,
    providerUsed: "anthropic",
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
    failureKind: null,
  };
}

/** Fold wasted batch spend into a sync-fallback GeneratedShell before persisting. */
export function mergeShellUsage(
  shell: GeneratedShell,
  prior: GenerateUsage,
  priorAttempts: number,
): GeneratedShell {
  return {
    ...shell,
    compileAttemptCount: shell.compileAttemptCount + priorAttempts,
    inputTokens: shell.inputTokens + prior.inputTokens,
    outputTokens: shell.outputTokens + prior.outputTokens,
    cacheReadTokens: shell.cacheReadTokens + prior.cacheReadTokens,
    cacheCreationTokens: shell.cacheCreationTokens + prior.cacheCreationTokens,
  };
}
