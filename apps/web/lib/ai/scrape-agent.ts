import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { fetchHtmlSafely, ScrapeFetchError } from "./scrape-fetch";
import { extractFromHtml, type ScrapeExtract } from "./scrape-extract";
import { getModelFor, type AllowedModel } from "./model";
import { pickColors, pickLogo } from "./scrape-design-deterministic";
import { getAnthropicClient } from "./client";
import { classifyAiError } from "./errors";

/**
 * Design-token scrape: given a URL, returns the structured design context
 * (colors + logo deterministically; typography / buttonPair / personality
 * from a single LLM call) that downstream callers (`extract-project-design`
 * Inngest fn, future preview surfaces) need to inform homepage generation.
 *
 * Pipeline:
 *   1. fetchHtmlSafely — SSRF-guarded, size-capped HTTPS GET
 *   2. extractFromHtml — Cheerio DOM → deterministic signals
 *   3. Deterministic colors + logo (no network, never fail)
 *   4. One LLM call for typography + buttonPair + personality, Zod-validated
 *
 * Returns the deterministic extract too so debug surfaces can audit
 * "what did the LLM actually see?" without re-running the fetch.
 *
 * History: this file used to run a two-pass content + design pipeline plus a
 * preview HTML renderer. As of the v2 Stage 0 teardown the content markdown
 * and renderer were dropped — the SaaS no longer ships a Replit-style preview
 * surface and the only live caller (`extract-project-design`) consumed the
 * design payload only. Prompts moved inline (the design prompts only) so the
 * single LLM call's contract lives in one file.
 */

const MAX_OUTPUT_TOKENS = 4096;
const FALLBACK_MODEL: AllowedModel = "claude-sonnet-4-6";

export class ScrapeAgentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "fetch_failed"
      | "extract_failed"
      | "design_pass_failed"
      // rare under structured outputs: JSON.parse failure (truncation) or Zod miss
      | "design_parse_failed",
    cause?: unknown,
    /**
     * Usage of the API call whose OUTPUT failed validation, when a response
     * completed (it was billed — the fallback path must account for it in
     * design_scrape_usage). Undefined when the call itself errored: no
     * response object, nothing to read.
     */
    public readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    // ES2022 options bag sets the native Error.cause slot so observability
    // tools reading the standard chaining protocol see the wrapped error.
    // No parameter-property needed: lib ES2022's `Error.cause?: unknown`
    // keeps `err.cause` reads type-stable for consumers.
    super(message, { cause });
    this.name = "ScrapeAgentError";
  }
}

/**
 * Fallback classifier — true means "escalating the identical prompt to
 * FALLBACK_MODEL could plausibly fix it":
 *
 *   - `design_parse_failed` — output-shape failure. Rare under structured
 *     outputs (JSON.parse failure on a truncated/empty response, or a Zod
 *     miss on the constraints the wire schema can't express); a stronger
 *     model may produce a valid shape.
 *   - `design_pass_failed` whose cause classifies as `bad_request` — a 400
 *     can be model-specific (request/schema shape rejection), so one
 *     escalation is worth a single try.
 *
 * Everything else — rate_limit, overloaded, server_error, connection,
 * auth, unknown — is not the model's fault: paying for a Sonnet retry of a
 * transport/env failure is pure waste, so those propagate unchanged.
 */
function isRetryableOnFallback(err: unknown): boolean {
  if (!(err instanceof ScrapeAgentError)) return false;
  if (err.code === "design_parse_failed") return true;
  return err.code === "design_pass_failed" && classifyAiError(err.cause) === "bad_request";
}

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
 * Zod schema for the full design payload. Colors + logo are produced
 * deterministically; the rest comes from the LLM and is validated against
 * `LlmDesignSubsetSchema` (below) before being merged in.
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

/** Per-call token usage in the shape persisted to projects.design_scrape_usage. */
interface DesignCallUsage {
  inputTokens: number;
  outputTokens: number;
}

function toCallUsage(usage: Anthropic.Messages.Usage): DesignCallUsage {
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

/**
 * Cost/fallback telemetry for the design pass — one entry per API call
 * actually dispatched. When the Haiku→Sonnet fallback fires, `primary`
 * records the WASTED first call (real usage when its response completed
 * but failed validation; zeros when the call itself errored) so the
 * fallback's true cost (primary + fallback) is never invisible.
 * Persisted verbatim to projects.design_scrape_usage (jsonb) by
 * extract-project-design.
 */
export interface DesignScrapeUsage {
  primary: { model: string; inputTokens: number; outputTokens: number };
  fallback?: { model: string; inputTokens: number; outputTokens: number };
  fallbackUsed: boolean;
  /** ISO timestamp of when the design pass completed. */
  at: string;
}

// ---------------------------------------------------------------------------
// Structured-outputs wire schema
// ---------------------------------------------------------------------------

/** Builds the { value, confidence, reasoning } object shape used by every field. */
function confidenceFieldSchema(valueSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      value: valueSchema,
      confidence: { type: "number" },
      reasoning: { type: "string" },
    },
    required: ["value", "confidence", "reasoning"],
    additionalProperties: false,
  };
}

/**
 * Wire schema for the design pass's structured output
 * (`output_config.format` with `type: "json_schema"`).
 *
 * Derived from `LlmDesignSubsetSchema`. Constraints structured outputs
 * cannot express are deliberately ABSENT here and enforced by Zod
 * `safeParse` after parsing instead:
 *   - `confidence` z.number().min(0).max(1)  → bare "number" on the wire
 *   - `reasoning` / `value` z.string().min(1) → bare "string" on the wire
 *
 * Everything structurally expressible IS expressed: additionalProperties
 * false on every object, exhaustive `required`, the energy enum, and
 * ["string","null"] unions for nullable values. A Zod miss is therefore
 * rare (empty reasoning string or out-of-range confidence) and is what
 * keeps the Haiku→Sonnet fallback as a residual escape hatch.
 */
export const DESIGN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    typography: {
      type: "object",
      properties: {
        heading: confidenceFieldSchema({ type: ["string", "null"] }),
        body: confidenceFieldSchema({ type: ["string", "null"] }),
      },
      required: ["heading", "body"],
      additionalProperties: false,
    },
    buttonPair: {
      type: "object",
      properties: {
        primary: confidenceFieldSchema({ type: ["string", "null"] }),
        secondary: confidenceFieldSchema({ type: ["string", "null"] }),
      },
      required: ["primary", "secondary"],
      additionalProperties: false,
    },
    personality: {
      type: "object",
      properties: {
        tone: confidenceFieldSchema({ type: "string" }),
        energy: confidenceFieldSchema({ type: "string", enum: ["low", "medium", "high"] }),
        audience: confidenceFieldSchema({ type: "string" }),
      },
      required: ["tone", "energy", "audience"],
      additionalProperties: false,
    },
  },
  required: ["typography", "buttonPair", "personality"],
  additionalProperties: false,
};

export interface DesignTokenScrapeResult {
  /** The final URL after redirects. */
  url: string;
  fetchedAt: string;
  byteSize: number;
  /** Deterministic extract — useful for debug + audit; also persisted alongside the JSON for "what did the model see?" introspection. */
  extract: ScrapeExtract;
  design: DesignAnalysis;
  /** Cost/fallback telemetry — persisted to projects.design_scrape_usage. */
  scrapeUsage: DesignScrapeUsage;
}

export interface DesignTokenScrapeInput {
  url: string;
  /** Forwarded to the fetch layer. */
  fetchOptions?: Parameters<typeof fetchHtmlSafely>[1];
  /**
   * Optional correlation label for log lines emitted from inside the agent
   * (e.g. Haiku→Sonnet fallback warnings). Callers conventionally pass
   * something like `extractProjectDesign <projectId>` so interleaved Inngest
   * worker logs stay legible.
   */
  label?: string;
}

// ---------------------------------------------------------------------------
// Anthropic client — thin wrapper over the shared `lib/ai/client.ts`
// singleton. Wrapping here preserves the `ScrapeAgentError` typed-error
// contract at the no-key path; the actual Anthropic instance lives in
// one place so SDK connection pooling + rate-limit state are shared.
// ---------------------------------------------------------------------------

function getClient(): Anthropic {
  try {
    return getAnthropicClient();
  } catch (err) {
    throw new ScrapeAgentError(
      err instanceof Error ? err.message : String(err),
      "design_pass_failed",
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runDesignTokenScrape(
  input: DesignTokenScrapeInput,
): Promise<DesignTokenScrapeResult> {
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

  // 3) Design pass — deterministic colors + logo, one LLM call for the rest.
  const designOutcome = await runDesignPass(extract, input.label);

  return {
    url: fetched.finalUrl,
    fetchedAt: new Date().toISOString(),
    byteSize: fetched.byteSize,
    extract,
    design: designOutcome.design,
    scrapeUsage: designOutcome.scrapeUsage,
  };
}

// ---------------------------------------------------------------------------
// Design pass
// ---------------------------------------------------------------------------

async function runDesignPass(
  extract: ScrapeExtract,
  label?: string,
): Promise<{ design: DesignAnalysis; scrapeUsage: DesignScrapeUsage }> {
  // Deterministic first — these never fail, never call the network.
  const colors = pickColors(extract);
  const logo = pickLogo(extract.images);

  // LLM handles the remaining fields (typography / buttonPair / personality).
  // Output failure + bad_request retry on Sonnet; transport failure propagates.
  const primary = getModelFor("design");
  let llmResult: { subset: LlmDesignSubset; usage: DesignCallUsage; model: AllowedModel };
  let scrapeUsage: DesignScrapeUsage;
  try {
    llmResult = await runDesignPassOnce(extract, primary);
    scrapeUsage = {
      primary: { model: primary, ...llmResult.usage },
      fallbackUsed: false,
      at: new Date().toISOString(),
    };
  } catch (err) {
    if (isRetryableOnFallback(err) && primary !== FALLBACK_MODEL) {
      const tag = label ? `[scrape-agent ${label}]` : "[scrape-agent]";
      console.warn(
        `${tag} design pass falling back ${primary} → ${FALLBACK_MODEL}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // The wasted primary call's usage: real numbers when a response
      // completed but failed validation (it was billed); zeros when the
      // call itself errored (bad_request — no response to read).
      const wasted: DesignCallUsage =
        err instanceof ScrapeAgentError && err.usage
          ? err.usage
          : { inputTokens: 0, outputTokens: 0 };
      llmResult = await runDesignPassOnce(extract, FALLBACK_MODEL);
      scrapeUsage = {
        primary: { model: primary, ...wasted },
        fallback: { model: FALLBACK_MODEL, ...llmResult.usage },
        fallbackUsed: true,
        at: new Date().toISOString(),
      };
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
    scrapeUsage,
  };
}

async function runDesignPassOnce(
  extract: ScrapeExtract,
  model: AllowedModel,
): Promise<{ subset: LlmDesignSubset; usage: DesignCallUsage; model: AllowedModel }> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: getDesignSystem(),
      messages: [{ role: "user", content: buildDesignUserPrompt(extract) }],
      // Structured outputs: the API constrains generation to
      // DESIGN_JSON_SCHEMA, so the response text IS the JSON document —
      // no fences, no prose, no regex extraction.
      output_config: { format: { type: "json_schema", schema: DESIGN_JSON_SCHEMA } },
    });
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass Anthropic call failed (model=${model}): ${err instanceof Error ? err.message : String(err)}`,
      "design_pass_failed",
      err,
    );
  }

  // A safety refusal is not an output-shape failure: escalating the
  // identical prompt to a stronger model won't un-refuse it. Throwing
  // design_pass_failed with NO cause means `classifyAiError(err.cause)`
  // resolves "unknown" — the fallback condition (bad_request cause
  // required) suppresses the second paid call by construction. Guarded
  // BEFORE JSON.parse so refusal prose can't masquerade as a retryable
  // design_parse_failed.
  if (response.stop_reason === "refusal") {
    throw new ScrapeAgentError(
      `Design-pass refused by safety classifier (stop_reason=refusal)`,
      "design_pass_failed",
    );
  }

  const usage = toCallUsage(response.usage);

  const fullText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // design_parse_failed is now the RARE arm: with structured outputs the
  // only ways JSON.parse can fail are a max_tokens truncation mid-JSON or
  // an empty response. The completed call WAS billed — attach its usage so
  // the fallback path can account for the waste.
  let parsed: unknown;
  try {
    parsed = JSON.parse(fullText);
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass JSON.parse failed (stop_reason=${response.stop_reason}): ${
        err instanceof Error ? err.message : String(err)
      }. First 200 chars: ${fullText.slice(0, 200)}`,
      "design_parse_failed",
      err,
      usage,
    );
  }

  // Zod re-validates the constraints the wire schema can't express
  // (confidence range, non-empty reasoning). Keep LlmDesignSubsetSchema in
  // strip (non-strict) mode — see its docblock.
  const result = LlmDesignSubsetSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScrapeAgentError(
      `Design-pass JSON failed schema validation: ${result.error.message}`,
      "design_parse_failed",
      result.error,
      usage,
    );
  }

  return { subset: result.data, usage, model };
}

// ---------------------------------------------------------------------------
// Prompts — design pass only
//
// Carried over verbatim from the deleted `scrape-prompts.ts`. The design
// pass produces a STRICT SUBSET of DesignAnalysis: typography + buttonPair
// + personality only. Colors + logo are computed deterministically in
// scrape-design-deterministic.ts and merged in by runDesignPass. The shrunk
// surface area is cheaper to run, less to mis-classify, and eliminates two
// failure-mode classes (palette substitution + "first image is the logo"
// confabulation) at the extraction layer rather than at the prompt rule level.
//
// Quality levers preserved here (do not casually edit):
//   - Indexed evidence references ("[0]", "[1]" in the user prompt) the
//     model is asked to cite back in its reasoning.
//   - "May NOT invent a family name that isn't in the input" anti-hallucination
//     rule on typography.
//   - "Under-claim, not over-claim" confidence guidance.
//   - h1/h2 slice cap (first 6 each) + 200-char per-item clamp (headings
//     and button text) so the user-prompt payload stays bounded.
// ---------------------------------------------------------------------------

const DESIGN_SYSTEM = `You are a design analyst. Given structured extracts from a website (font samples, button text, headings), you classify the site's typography choices, CTA hierarchy, and brand personality.

You respond with a single JSON object matching the response schema. For reference, the shape is:

{
  "typography": {
    "heading": { "value": "Family Name" | null, "confidence": 0.0, "reasoning": "..." },
    "body":    { "value": "Family Name" | null, "confidence": 0.0, "reasoning": "..." }
  },
  "buttonPair": {
    "primary":   { "value": "..." | null, "confidence": 0.0, "reasoning": "..." },
    "secondary": { "value": "..." | null, "confidence": 0.0, "reasoning": "..." }
  },
  "personality": {
    "tone":     { "value": "...", "confidence": 0.0, "reasoning": "One short phrase: playful / serious / luxe / utilitarian / etc." },
    "energy":   { "value": "low" | "medium" | "high", "confidence": 0.0, "reasoning": "..." },
    "audience": { "value": "...", "confidence": 0.0, "reasoning": "Who is this site for, in one phrase." }
  }
}

Rules:
- Confidence is a number between 0 and 1. Be honest about uncertainty — under-claim, not over-claim.
- Reasoning must cite the actual evidence ("the heading samples are all in Playfair Display" / "the 'Book a discovery call' button is the only one in the header region") — not generic justifications. Reasoning must never be an empty string.
- Typography: pick from the font samples provided. The model may NOT invent a family name that isn't in the input.
- ButtonPair: primary is the single most prominent CTA (header / hero region preferred). Secondary is the next-most-prominent if one exists; null otherwise.
- Personality: infer from the headings, button copy, and overall content register. Audience is "who is this site for, in one phrase."
- If you genuinely cannot infer a field, set its value to null and confidence to 0.`;

function getDesignSystem(): string {
  return DESIGN_SYSTEM;
}

/**
 * Per-item clamp for free-text strings riding into the design prompt.
 * The extractor already count-caps buttons (12) and fonts (8); headings
 * and button TEXT length were the remaining unbounded inputs — broken CMS
 * markup commonly emits dozens of h1s (every card title), each of which
 * used to ride into the Haiku input uncapped.
 */
const MAX_PROMPT_ITEM_CHARS = 200;
const MAX_HEADINGS = 6;

function clampItem(s: string): string {
  return s.length > MAX_PROMPT_ITEM_CHARS ? s.slice(0, MAX_PROMPT_ITEM_CHARS) : s;
}

/** Exported for unit tests only — not part of the module's public API. */
export function buildDesignUserPrompt(extract: ScrapeExtract): string {
  const lines: string[] = [];

  lines.push("Source URL:", extract.url, "");
  if (extract.title) lines.push("Title:", extract.title, "");
  if (extract.description) lines.push("Description:", extract.description);
  lines.push("");

  if (extract.fontSamples.length > 0) {
    lines.push("Font-family samples (frequency-ranked):");
    extract.fontSamples.forEach((f, i) => lines.push(`[${i}] ${f}`));
  } else {
    lines.push("Font-family samples: NONE found in inline styles");
  }
  lines.push("");

  if (extract.buttons.length > 0) {
    lines.push("Button-like elements (for primary/secondary CTA classification):");
    extract.buttons.forEach((b, i) =>
      lines.push(`[${i}] "${clampItem(b.text)}" (${b.region})${b.href ? ` → ${b.href}` : ""}`),
    );
    lines.push("");
  }

  if (extract.h1.length > 0 || extract.h2.length > 0) {
    lines.push("Headings (for personality inference):");
    extract.h1.slice(0, MAX_HEADINGS).forEach((h) => lines.push(`- h1: ${clampItem(h)}`));
    extract.h2.slice(0, MAX_HEADINGS).forEach((h) => lines.push(`- h2: ${clampItem(h)}`));
    lines.push("");
  }

  lines.push(
    "Produce the design JSON now. Cite the indexed evidence in your reasoning.",
  );

  return lines.join("\n");
}
