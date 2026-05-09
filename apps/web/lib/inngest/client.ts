import { Inngest } from "inngest";

/**
 * Inngest client — the durable-execution layer for AI page generation.
 *
 * Why Inngest and not "just call the API and await it"?
 *   - Generation takes 60-120s per page. Long-running blocking requests are
 *     a bad fit for Vercel functions (timeouts, cold-start retries cause
 *     duplicate work).
 *   - Step-level retries: Anthropic 5xx, GitHub 5xx, transient network blips
 *     should retry without re-running the previous successful steps.
 *   - Observability: every job's step graph is visible in the Inngest dev UI
 *     and the Inngest Cloud dashboard.
 *
 * Dev: Inngest dev server (`npx inngest-cli@latest dev`) auto-discovers this
 * client by pinging the /api/inngest route below. No keys required.
 *
 * Prod: set INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY in the deploy env.
 */
export const inngest = new Inngest({
  id: "jab-saas",
});
