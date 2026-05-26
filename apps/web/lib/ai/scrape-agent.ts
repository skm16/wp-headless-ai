import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { fetchHtmlSafely, ScrapeFetchError } from "./scrape-fetch";
import { extractFromHtml, type ScrapeExtract } from "./scrape-extract";
import { getModelFor, type AllowedModel } from "./model";
import { pickColors, pickLogo } from "./scrape-design-deterministic";
import { getAnthropicClient } from "./client";

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
      | "design_parse_failed",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScrapeAgentError";
  }
}

/**
 * Retry classifier — true means "the model botched the output; retrying
 * with a stronger model could fix it." Transport / env failures aren't the
 * model's fault, so they propagate without escalating.
 */
function isRetryableOnFallback(err: unknown): boolean {
  return (
    err instanceof ScrapeAgentError && err.code === "design_parse_failed"
  );
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

export interface DesignTokenScrapeResult {
  /** The final URL after redirects. */
  url: string;
  fetchedAt: string;
  byteSize: number;
  /** Deterministic extract — useful for debug + audit; also persisted alongside the JSON for "what did the model see?" introspection. */
  extract: ScrapeExtract;
  design: DesignAnalysis;
  usage: { design: Anthropic.Messages.Usage };
  /** Model actually dispatched for the design call (post-fallback). */
  models: { design: AllowedModel };
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
    usage: { design: designOutcome.usage },
    models: { design: designOutcome.model },
  };
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
  // Output failure retries on Sonnet; transport failure propagates.
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
//   - h2 slice cap (first 6) so the user-prompt payload stays bounded for
//     large pages with deep section trees.
// ---------------------------------------------------------------------------

const DESIGN_SYSTEM = `You are a design analyst. Given structured extracts from a website (font samples, button text, headings), you classify the site's typography choices, CTA hierarchy, and brand personality.

Output format — a single JSON object inside a \`\`\`json code block. No prose before or after.

Required shape:

\`\`\`json
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
\`\`\`

Rules:
- Confidence is a number between 0 and 1. Be honest about uncertainty — under-claim, not over-claim.
- Reasoning must cite the actual evidence ("the heading samples are all in Playfair Display" / "the 'Book a discovery call' button is the only one in the header region") — not generic justifications.
- Typography: pick from the font samples provided. The model may NOT invent a family name that isn't in the input.
- ButtonPair: primary is the single most prominent CTA (header / hero region preferred). Secondary is the next-most-prominent if one exists; null otherwise.
- Personality: infer from the headings, button copy, and overall content register. Audience is "who is this site for, in one phrase."
- If you genuinely cannot infer a field, set its value to null and confidence to 0.`;

function getDesignSystem(): string {
  return DESIGN_SYSTEM;
}

function buildDesignUserPrompt(extract: ScrapeExtract): string {
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
      lines.push(`[${i}] "${b.text}" (${b.region})${b.href ? ` → ${b.href}` : ""}`),
    );
    lines.push("");
  }

  if (extract.h1.length > 0 || extract.h2.length > 0) {
    lines.push("Headings (for personality inference):");
    extract.h1.forEach((h) => lines.push(`- h1: ${h}`));
    extract.h2.slice(0, 6).forEach((h) => lines.push(`- h2: ${h}`));
    lines.push("");
  }

  lines.push(
    "Produce the design JSON now. Cite the indexed evidence in your reasoning.",
  );

  return lines.join("\n");
}
