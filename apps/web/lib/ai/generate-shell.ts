import "server-only";
import type { ThemeJsonTokens } from "@/lib/jab/global-styles";
import { MAX_TOKENS_BY_TIER, type ModelClient } from "./model-client";
import { validateTsx, buildRetryUserSuffix, type GenerationFailureKind } from "./component-generator";
import { classifyAiError, isRetryableAiFailure } from "./errors";
import {
  headerPrompt,
  footerPrompt,
  shellDeterministicFallback,
  shouldCacheShellPrefix,
  type ShellMenu,
} from "./shell-prompts";
import { postprocessGeneratedTsx } from "./generated-tsx-postprocess";
import { rewriteWpOriginUrls } from "@/lib/jab/rewrite-origin-links";

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

export async function generateShell(opts: GenerateShellOptions): Promise<GeneratedShell> {
  const { kind, client, shellDom, menu, siteName } = opts;

  // Origin rewriter — applied at every TSX exit so generated nav links stay
  // on the clone regardless of which path produced the TSX.
  const relink = (tsx: string): string =>
    opts.sourceHosts && opts.sourceHosts.length > 0
      ? rewriteWpOriginUrls(tsx, { sourceHosts: opts.sourceHosts, routePathMap: opts.routePathMap })
      : tsx;

  // Missing-input short-circuit: empty shellDom means no source DOM was
  // captured for this shell kind. Skip the LLM entirely and return the
  // deterministic fallback — same pattern as passthrough blocks in
  // component-generator.ts.
  if (!shellDom || shellDom.trim().length === 0) {
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

  const promptInput = {
    shellDom,
    themeTokens: opts.themeTokens,
    themeClassNames: opts.themeClassNames,
    shellColors: opts.shellColors,
    menu,
    logoUrl: opts.logoUrl,
    siteName,
    siteDescription: opts.siteDescription,
    guidance: opts.guidance,
    sourceHost: opts.sourceHost,
  };
  const built = kind === "header" ? headerPrompt(promptInput) : footerPrompt(promptInput);

  // Caching decision at build time: the stable half (rules + tokens + theme
  // classes + menu) only clears Sonnet's 2048-token minimum when large
  // enough. When cached, the second (uncached) system block must still be
  // non-empty — it carries the per-kind instruction line. Header and footer
  // share a byte-identical stable half, and compose-site runs them
  // sequentially, so the footer call reads the header call's cache write.
  const useCachedPrefix = shouldCacheShellPrefix(built.system);
  const cachedSystemPrefix = useCachedPrefix ? built.system : undefined;
  const systemPrompt = useCachedPrefix
    ? `Generate the site ${kind} chrome component per the contract in the cached system block.`
    : built.system;
  const baseUserPrompt = built.user;
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
      retryErrors = [];
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
