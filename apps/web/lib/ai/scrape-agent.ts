import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { fetchHtmlSafely, ScrapeFetchError } from "./scrape-fetch";
import { extractFromHtml, type ScrapeExtract } from "./scrape-extract";
import { getModelFor, type AllowedModel } from "./model";
import {
  buildContentUserPrompt,
  buildDesignUserPrompt,
  getContentSystem,
  getDesignSystem,
} from "./scrape-prompts";
import { pickColors, pickLogo } from "./scrape-design-deterministic";
import { getAnthropicClient } from "./client";

/**
 * Public-HTML scrape agent. Powers the `/preview` wow path: given a URL,
 * returns the structured content + design context that the downstream
 * generation worker needs to produce a homepage rebuild.
 *
 * Replaces the `setTimeout`-based mock in
 * `apps/web/app/preview/preview-flow.tsx`. The user-facing state machine
 * stays the same — UI is unchanged — but the data flowing through it is
 * now real.
 *
 * Pipeline (transition doc §10):
 *   1. fetchHtmlSafely — SSRF-guarded, size-capped HTTPS GET
 *   2. extractFromHtml — Cheerio DOM → deterministic signals
 *   3. Two LLM passes IN PARALLEL:
 *        - content: prose markdown describing what the site is/says
 *        - design:  JSON with per-field confidence + reasoning
 *      Per-concern separation imported from Replit's reference; see
 *      `docs/saas-mvp-transition.md` §10 and design plan §15 for rationale.
 *   4. Validate both, return.
 *
 * Returns the deterministic extract too so debugging surfaces (and
 * future Phase 3 fidelity work) can audit "what did the LLM actually
 * see?" without re-running the fetch.
 */

const MAX_OUTPUT_TOKENS = 4096;

export class ScrapeAgentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "fetch_failed"
      | "extract_failed"
      | "content_pass_failed"
      | "content_pass_empty"
      | "design_pass_failed"
      | "design_parse_failed",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScrapeAgentError";
  }
}

/**
 * Retry classifier — true means "the model botched the output; retrying
 * with a different (stronger) model could fix it." False means "transport
 * or env failure; the model isn't the problem." Used by the per-pass
 * orchestrators to decide whether to fall back from Haiku to Sonnet.
 */
function isRetryableOnFallback(err: unknown): boolean {
  return (
    err instanceof ScrapeAgentError &&
    (err.code === "content_pass_empty" || err.code === "design_parse_failed")
  );
}

const FALLBACK_MODEL: AllowedModel = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

const ConfidenceFieldSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value: value,
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
  });

/**
 * Zod schema for the design-pass output. Mirrors the JSON shape declared in
 * `scrape-prompts.ts` `DESIGN_SYSTEM`. Stays here (not in prompts.ts) so the
 * prompt and the parser can drift only via this file — a single place to
 * update when fields change.
 */
export const DesignAnalysisSchema = z.object({
  colors: z.object({
    primary: ConfidenceFieldSchema(z.string().regex(/^#[0-9a-fA-F]{6}$/)),
    secondary: ConfidenceFieldSchema(
      z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
    ),
    accent: ConfidenceFieldSchema(
      z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
    ),
  }),
  typography: z.object({
    heading: ConfidenceFieldSchema(z.string().min(1).nullable()),
    body: ConfidenceFieldSchema(z.string().min(1).nullable()),
  }),
  logo: z.object({
    src: z.string().url().nullable(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1),
  }),
  buttonPair: z.object({
    // Both nullable: personal blogs / portfolio sites legitimately ship
    // without a prominent CTA. The prompt's "if you can't infer, set to
    // null with confidence 0" rule applies — schema mirrors that contract.
    primary: ConfidenceFieldSchema(z.string().min(1).nullable()),
    secondary: ConfidenceFieldSchema(z.string().min(1).nullable()),
  }),
  personality: z.object({
    tone: ConfidenceFieldSchema(z.string().min(1)),
    energy: ConfidenceFieldSchema(z.enum(["low", "medium", "high"])),
    audience: ConfidenceFieldSchema(z.string().min(1)),
  }),
});

export type DesignAnalysis = z.infer<typeof DesignAnalysisSchema>;

/**
 * Strict subset of `DesignAnalysisSchema` covering only the fields the LLM
 * produces today. Colors and logo are computed deterministically (see
 * scrape-design-deterministic.ts) and merged in by `runDesignPass` to form
 * the full DesignAnalysis. Keeping these as a separate schema lets the
 * model fail cleanly on the small shape it's actually responsible for.
 *
 * IMPORTANT: do NOT add `.strict()` here. Zod 3's default `strip` mode
 * silently drops any `colors` / `logo` fields a Haiku response habit-fully
 * emits (the old shape) — desired behavior. Tightening to strict would
 * convert those stripped extras into validation failures, which
 * `isRetryableOnFallback` classifies as retryable — every stale-shape
 * Haiku call would silently escalate to Sonnet (cost waste).
 */
const LlmDesignSubsetSchema = DesignAnalysisSchema.omit({
  colors: true,
  logo: true,
});
type LlmDesignSubset = z.infer<typeof LlmDesignSubsetSchema>;

export interface ScrapeAgentResult {
  /** The final URL after redirects. */
  url: string;
  fetchedAt: string;
  byteSize: number;
  /** Deterministic extract — useful for debug + audit; also persisted alongside the JSON for "what did the model see?" introspection. */
  extract: ScrapeExtract;
  contentMarkdown: string;
  design: DesignAnalysis;
  usage: {
    content: Anthropic.Messages.Usage;
    design: Anthropic.Messages.Usage;
  };
  /**
   * Models actually dispatched per pass. Captured per call (not pulled from
   * a single shared constant) so a `JAB_AI_MODEL_CONTENT=haiku` /
   * `JAB_AI_MODEL_DESIGN=sonnet` split is honestly recorded.
   */
  models: { content: AllowedModel; design: AllowedModel };
}

export interface ScrapeAgentInput {
  url: string;
  /** Forwarded to the fetch layer. */
  fetchOptions?: Parameters<typeof fetchHtmlSafely>[1];
  /**
   * Optional correlation label for log lines emitted from inside the agent
   * (e.g. Haiku→Sonnet fallback warnings). Callers conventionally pass
   * something like `scrapePreview <previewId>` or `extractProjectDesign
   * <projectId>` so interleaved Inngest worker logs stay legible.
   */
  label?: string;
}

// ---------------------------------------------------------------------------
// Anthropic client — thin wrapper over the shared `lib/ai/client.ts`
// singleton. Wrapping here preserves the `ScrapeAgentError` typed-error
// contract at the no-key path; the actual Anthropic instance lives in
// one place so SDK connection pooling + rate-limit state are shared
// across the content / design / render passes.
// ---------------------------------------------------------------------------

function getClient(): Anthropic {
  try {
    return getAnthropicClient();
  } catch (err) {
    throw new ScrapeAgentError(
      err instanceof Error ? err.message : String(err),
      "content_pass_failed",
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runScrapeAgent(
  input: ScrapeAgentInput,
): Promise<ScrapeAgentResult> {
  // 1) Fetch
  let fetched: Awaited<ReturnType<typeof fetchHtmlSafely>>;
  try {
    fetched = await fetchHtmlSafely(input.url, input.fetchOptions);
  } catch (err) {
    if (err instanceof ScrapeFetchError) {
      throw new ScrapeAgentError(err.message, "fetch_failed", err);
    }
    throw new ScrapeAgentError(
      `Unexpected fetch error: ${err instanceof Error ? err.message : String(err)}`,
      "fetch_failed",
      err,
    );
  }

  // 2) Extract
  let extract: ScrapeExtract;
  try {
    extract = extractFromHtml(fetched.html, fetched.finalUrl);
  } catch (err) {
    throw new ScrapeAgentError(
      `DOM extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      "extract_failed",
      err,
    );
  }

  // 3) Two LLM passes in parallel — independent concerns, no cross-dependency.
  //    Errors are isolated per pass so we don't lose one when the other fails.
  //    Worst-case cost: 4 LLM calls per scrape (2 Haiku + 2 Sonnet fallback)
  //    when both passes botch their primary output. Bounded structurally —
  //    no inner retry loop, max one fallback per pass.
  const [contentOutcome, designOutcome] = await Promise.allSettled([
    runContentPass(extract, input.label),
    runDesignPass(extract, input.label),
  ]);

  if (contentOutcome.status === "rejected") {
    throw contentOutcome.reason;
  }
  if (designOutcome.status === "rejected") {
    throw designOutcome.reason;
  }

  return {
    url: fetched.finalUrl,
    fetchedAt: new Date().toISOString(),
    byteSize: fetched.byteSize,
    extract,
    contentMarkdown: contentOutcome.value.markdown,
    design: designOutcome.value.design,
    usage: {
      content: contentOutcome.value.usage,
      design: designOutcome.value.usage,
    },
    models: {
      content: contentOutcome.value.model,
      design: designOutcome.value.model,
    },
  };
}

// ---------------------------------------------------------------------------
// Content pass
// ---------------------------------------------------------------------------

async function runContentPass(
  extract: ScrapeExtract,
  label?: string,
): Promise<{ markdown: string; usage: Anthropic.Messages.Usage; model: AllowedModel }> {
  const primary = getModelFor("content");
  try {
    return await runContentPassOnce(extract, primary);
  } catch (err) {
    if (isRetryableOnFallback(err) && primary !== FALLBACK_MODEL) {
      const tag = label ? `[scrape-agent ${label}]` : "[scrape-agent]";
      console.warn(
        `${tag} content pass falling back ${primary} → ${FALLBACK_MODEL}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return await runContentPassOnce(extract, FALLBACK_MODEL);
    }
    throw err;
  }
}

async function runContentPassOnce(
  extract: ScrapeExtract,
  model: AllowedModel,
): Promise<{ markdown: string; usage: Anthropic.Messages.Usage; model: AllowedModel }> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: getContentSystem(),
      messages: [{ role: "user", content: buildContentUserPrompt(extract) }],
    });
  } catch (err) {
    throw new ScrapeAgentError(
      `Content-pass Anthropic call failed (model=${model}): ${err instanceof Error ? err.message : String(err)}`,
      "content_pass_failed",
      err,
    );
  }

  const markdown = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!markdown) {
    throw new ScrapeAgentError(
      `Content-pass returned empty text (model=${model}, stop_reason=${response.stop_reason})`,
      "content_pass_empty",
    );
  }

  return { markdown, usage: response.usage, model };
}

// ---------------------------------------------------------------------------
// Design pass
// ---------------------------------------------------------------------------

async function runDesignPass(
  extract: ScrapeExtract,
  label?: string,
): Promise<{ design: DesignAnalysis; usage: Anthropic.Messages.Usage; model: AllowedModel }> {
  // Deterministic first — these never fail, never call the network.
  const colors = pickColors(extract);
  const logo = pickLogo(extract.images);

  // LLM handles the remaining fields (typography / buttonPair / personality).
  // Fallback semantics are identical to the content pass — output failure
  // retries on Sonnet, transport failure propagates.
  const primary = getModelFor("design");
  let llmResult: { subset: LlmDesignSubset; usage: Anthropic.Messages.Usage; model: AllowedModel };
  try {
    llmResult = await runDesignPassOnce(extract, primary);
  } catch (err) {
    if (isRetryableOnFallback(err) && primary !== FALLBACK_MODEL) {
      const tag = label ? `[scrape-agent ${label}]` : "[scrape-agent]";
      console.warn(
        `${tag} design pass falling back ${primary} → ${FALLBACK_MODEL}: ${err instanceof Error ? err.message : String(err)}`,
      );
      llmResult = await runDesignPassOnce(extract, FALLBACK_MODEL);
    } else {
      throw err;
    }
  }

  return {
    design: {
      colors,
      logo,
      ...llmResult.subset,
    },
    usage: llmResult.usage,
    model: llmResult.model,
  };
}

async function runDesignPassOnce(
  extract: ScrapeExtract,
  model: AllowedModel,
): Promise<{ subset: LlmDesignSubset; usage: Anthropic.Messages.Usage; model: AllowedModel }> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: getDesignSystem(),
      messages: [{ role: "user", content: buildDesignUserPrompt(extract) }],
    });
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass Anthropic call failed (model=${model}): ${err instanceof Error ? err.message : String(err)}`,
      "design_pass_failed",
      err,
    );
  }

  const fullText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const jsonStr = extractJsonBlock(fullText);
  if (!jsonStr) {
    throw new ScrapeAgentError(
      `Design-pass response did not include a json code block (stop_reason=${response.stop_reason}). First 200 chars: ${fullText.slice(0, 200)}`,
      "design_parse_failed",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass JSON.parse failed: ${err instanceof Error ? err.message : String(err)}. First 200 chars: ${jsonStr.slice(0, 200)}`,
      "design_parse_failed",
      err,
    );
  }

  const result = LlmDesignSubsetSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScrapeAgentError(
      `Design-pass JSON failed schema validation: ${result.error.message}`,
      "design_parse_failed",
      result.error,
    );
  }

  return { subset: result.data, usage: response.usage, model };
}

/**
 * Pulls the first ```json fenced block out of a text response. Same
 * tolerance pattern as `agent.ts`'s `extractCodeBlock` (whitespace before
 * closing fence is fine).
 */
function extractJsonBlock(text: string): string | null {
  const re = /```json\s*\n([\s\S]*?)\n\s*```/i;
  const m = text.match(re);
  if (m) return m[1]!.trim();
  // Tolerance fallback: the model occasionally forgets the language tag.
  const reAny = /```\s*\n(\{[\s\S]*?\})\n\s*```/i;
  const mAny = text.match(reAny);
  return mAny ? mAny[1]!.trim() : null;
}
