import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { ScrapeAgentResult } from "./scrape-agent";
import { MODEL } from "./model";
import { buildRenderPrompt, getRenderSystem, type RenderIntent } from "./render-prompts";

/**
 * Wow-preview renderer — turns a ScrapeAgentResult into a self-contained
 * HTML document the iframe shows via `srcDoc`.
 *
 * This is the third LLM call in the wow pipeline (after content + design).
 * Kept in its own file so it can evolve independently: the prompt here is
 * a *creative* call (write copy, lay out a section), where the scrape-agent
 * passes are *extractive* (classify, pick, structure). Different concerns,
 * different tuning.
 *
 * Why Sonnet (not Opus): same reasoning as `agent.ts` after the model
 * flip. Sonnet 4.6 produces marketing-quality static HTML at agency-
 * acceptable quality, faster + cheaper. Validation will tell us if we
 * need Opus for outlier sites.
 */

/**
 * 8192 was the original cap; production runs on content-heavy sites
 * (e.g. Two Roads Brewing) regularly hit it mid-document, producing a
 * `stop_reason=max_tokens` truncation with no closing ```` ``` ```` fence.
 * Sonnet 4.6 supports up to 64k output tokens; 16384 is a conservative
 * double that comfortably fits a complete marketing page (nav + hero +
 * 2-3 sections + footer + 3 responsive breakpoints of inline CSS).
 */
const MAX_OUTPUT_TOKENS = 16384;

export class PreviewRendererError extends Error {
  constructor(
    message: string,
    public readonly code: "anthropic_failed" | "no_html_block",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PreviewRendererError";
  }
}

export interface PreviewRenderResult {
  html: string;
  usage: Anthropic.Messages.Usage;
  model: typeof MODEL;
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new PreviewRendererError(
      "ANTHROPIC_API_KEY not set",
      "anthropic_failed",
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export async function renderPreviewHtml(
  scrape: ScrapeAgentResult,
  opts: { intent?: RenderIntent } = {},
): Promise<PreviewRenderResult> {
  const client = getClient();

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: getRenderSystem(),
      messages: [
        { role: "user", content: buildRenderPrompt(scrape, { intent: opts.intent }) },
      ],
    });
  } catch (err) {
    throw new PreviewRendererError(
      `Renderer Anthropic call failed: ${err instanceof Error ? err.message : String(err)}`,
      "anthropic_failed",
      err,
    );
  }

  const fullText = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const html = extractHtmlBlock(fullText);
  if (!html) {
    throw new PreviewRendererError(
      `Renderer response did not include an html code block (stop_reason=${response.stop_reason}). First 200 chars: ${fullText.slice(0, 200)}`,
      "no_html_block",
    );
  }

  return { html, usage: response.usage, model: MODEL };
}

/**
 * Pulls the first ```html fenced block. Tolerant in two ways:
 *   1. The language tag may be missing (model dropped it but emitted a doctype).
 *   2. The closing fence may be missing — happens when stop_reason=max_tokens
 *      cuts the model off mid-document. Browsers recover from a missing
 *      </body></html> via their HTML parser's error correction, so showing
 *      a partial preview is strictly better than showing the user an error.
 */
function extractHtmlBlock(text: string): string | null {
  // Open fence with ```html → content → optional closing fence or end-of-string.
  const re = /```html\s*\n([\s\S]*?)(?:\n\s*```|$)/i;
  const m = text.match(re);
  if (m) return m[1]!.trim();
  // Fallback — model dropped the language tag but emitted a doctype.
  const reAny = /```\s*\n(<!doctype[\s\S]*?)(?:\n\s*```|$)/i;
  const mAny = text.match(reAny);
  if (mAny) return mAny[1]!.trim();
  // Last resort — no fence at all but a doctype is present (model ignored
  // the fenced-block instruction). Take everything from <!doctype onward.
  const reBare = /<!doctype[\s\S]*$/i;
  const mBare = text.match(reBare);
  return mBare ? mBare[0]!.trim() : null;
}
