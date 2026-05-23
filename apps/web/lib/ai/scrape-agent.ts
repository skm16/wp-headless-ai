import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { fetchHtmlSafely, ScrapeFetchError } from "./scrape-fetch";
import { extractFromHtml, type ScrapeExtract } from "./scrape-extract";
import {
  buildContentUserPrompt,
  buildDesignUserPrompt,
  getContentSystem,
  getDesignSystem,
} from "./scrape-prompts";

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

const MODEL = "claude-sonnet-4-6" as const;
const MAX_OUTPUT_TOKENS = 4096;

export class ScrapeAgentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "fetch_failed"
      | "extract_failed"
      | "content_pass_failed"
      | "design_pass_failed"
      | "design_parse_failed",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScrapeAgentError";
  }
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
 * Zod schema for the design-pass output. Mirrors the JSON shape declared in
 * `scrape-prompts.ts` `DESIGN_SYSTEM`. Stays here (not in prompts.ts) so the
 * prompt and the parser can drift only via this file — a single place to
 * update when fields change.
 */
const DesignAnalysisSchema = z.object({
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
    primary: ConfidenceFieldSchema(z.string().min(1)),
    secondary: ConfidenceFieldSchema(z.string().min(1).nullable()),
  }),
  personality: z.object({
    tone: ConfidenceFieldSchema(z.string().min(1)),
    energy: ConfidenceFieldSchema(z.enum(["low", "medium", "high"])),
    audience: ConfidenceFieldSchema(z.string().min(1)),
  }),
});

export type DesignAnalysis = z.infer<typeof DesignAnalysisSchema>;

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
  model: typeof MODEL;
}

export interface ScrapeAgentInput {
  url: string;
  /** Forwarded to the fetch layer. */
  fetchOptions?: Parameters<typeof fetchHtmlSafely>[1];
}

// ---------------------------------------------------------------------------
// Anthropic client (lazy singleton, same pattern as lib/ai/agent.ts)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ScrapeAgentError(
      "ANTHROPIC_API_KEY not set. Generate at console.anthropic.com → API Keys.",
      "content_pass_failed",
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
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
  const [contentOutcome, designOutcome] = await Promise.allSettled([
    runContentPass(extract),
    runDesignPass(extract),
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
    model: MODEL,
  };
}

// ---------------------------------------------------------------------------
// Content pass
// ---------------------------------------------------------------------------

async function runContentPass(
  extract: ScrapeExtract,
): Promise<{ markdown: string; usage: Anthropic.Messages.Usage }> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: getContentSystem(),
      messages: [{ role: "user", content: buildContentUserPrompt(extract) }],
    });
  } catch (err) {
    throw new ScrapeAgentError(
      `Content-pass Anthropic call failed: ${err instanceof Error ? err.message : String(err)}`,
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
      `Content-pass returned empty text (stop_reason=${response.stop_reason})`,
      "content_pass_failed",
    );
  }

  return { markdown, usage: response.usage };
}

// ---------------------------------------------------------------------------
// Design pass
// ---------------------------------------------------------------------------

async function runDesignPass(
  extract: ScrapeExtract,
): Promise<{ design: DesignAnalysis; usage: Anthropic.Messages.Usage }> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: getDesignSystem(),
      messages: [{ role: "user", content: buildDesignUserPrompt(extract) }],
    });
  } catch (err) {
    throw new ScrapeAgentError(
      `Design-pass Anthropic call failed: ${err instanceof Error ? err.message : String(err)}`,
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

  const result = DesignAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScrapeAgentError(
      `Design-pass JSON failed schema validation: ${result.error.message}`,
      "design_parse_failed",
      result.error,
    );
  }

  return { design: result.data, usage: response.usage };
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
