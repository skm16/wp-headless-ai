import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared Anthropic SDK singleton.
 *
 * Why a single instance rather than per-module singletons: the SDK manages
 * HTTP keep-alive, retry state, and rate-limit backoff internally. Multiple
 * instances on the same Next.js server process would double the connection
 * pool and isolate rate-limit signal, surfacing as unexplained 529/overload
 * errors under concurrent load. One instance, one shared backoff state.
 *
 * Today's only consumer is `scrape-agent.ts` (design-token pass). The
 * module-local `getClient()` wrapper there preserves the `ScrapeAgentError`
 * typed-error contract by catching the generic Error this function throws
 * on missing-key and re-wrapping.
 */

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY not set. Generate at console.anthropic.com → API Keys.",
    );
  }
  _client = new Anthropic({ apiKey });
  return _client;
}
