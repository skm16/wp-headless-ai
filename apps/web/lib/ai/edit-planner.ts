import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { EDIT_PLAN_TOOL_SCHEMA, type EditPlan } from "@/lib/jab/edit-plan";
import type { TokenDelta } from "@/lib/jab/token-override";
import { getAnthropicClient } from "./client";
import { getModelFor } from "./model";
import type { SiteMap } from "@/lib/jab/site-map";
import {
  EditBudgetError,
  estimateTokens,
  PLANNER_COST_CAP_TOKENS,
  PLANNER_MAX_TURNS,
} from "./edit-cost-guard";
import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";
import type { StopReason } from "./model-client";

/** First-attempt output budget — right-sized for a small structured plan. */
const PLANNER_MAX_OUTPUT_TOKENS = 1024;
/** Single-retry budget when the first attempt truncates at max_tokens. */
const PLANNER_RETRY_MAX_OUTPUT_TOKENS = 2048;

/**
 * edit-planner — the constrained planner LLM (spec §3.3). Sonnet, tool-use
 * forced to EDIT_PLAN_TOOL_SCHEMA so the model can ONLY emit a structured plan
 * (scope ∈ component|shell). Biased toward a clarifying question on low
 * confidence (R2). Injectable PlannerClient keeps the call mockable in tests.
 */

export interface PlannerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Per-call metadata threaded into chat telemetry. Persisted INSIDE the
 * existing chat_messages.plan jsonb as a `plannerMeta` key — deliberately no
 * new column / migration (Phase 5 decision).
 */
export interface PlannerCallMeta {
  /** stop_reason of the FINAL attempt ("max_tokens" ⇒ truncated even after the retry). */
  stopReason: StopReason;
  /** true when attempt 1 hit max_tokens and the single 2048 retry was made. */
  retriedForMaxTokens: boolean;
}

/** Client result = tool input + usage + the PlannerCallMeta fields (extends
 *  so the two surfaces can never drift — planEdit re-packages the meta). */
export interface PlannerClientResult extends PlannerCallMeta {
  toolInput: Record<string, unknown>;
  usage: PlannerUsage;
}

export interface PlannerMessage {
  role: "user" | "assistant";
  content: string;
}

/** Injectable seam — the real impl calls Anthropic; tests pass a mock. */
export interface PlannerClient {
  createPlan(args: { system: string; messages: PlannerMessage[] }): Promise<PlannerClientResult>;
}

function isScope(v: unknown): v is WorkspaceEditScope {
  return v === "component" || v === "shell" || v === "tokens";
}

/** Coerce arbitrary tool-call JSON to a typed EditPlan (defensive). */
export function parsePlannerToolUse(input: Record<string, unknown>): EditPlan {
  const scope = isScope(input.scope) ? input.scope : "component";
  return {
    needsClarification: input.needsClarification === true,
    scope,
    target: typeof input.target === "string" ? input.target : "",
    action: typeof input.action === "string" ? input.action : "",
    regenerationPrompt: typeof input.regenerationPrompt === "string" ? input.regenerationPrompt : "",
    clarifyingQuestion:
      typeof input.clarifyingQuestion === "string" ? input.clarifyingQuestion : null,
    // Structured validation (injection-safe) happens in validateEditPlan — here
    // we only shape-coerce: a non-object becomes null.
    tokenDelta:
      input.tokenDelta && typeof input.tokenDelta === "object" && !Array.isArray(input.tokenDelta)
        ? (input.tokenDelta as TokenDelta)
        : null,
  };
}

function buildSystemPrompt(siteMap: SiteMap): string {
  const blockLines = siteMap.blockTypes
    .map((b) => {
      // page_slugs is capped at 50, so pageCountIsFloor blocks render "at least N"
      // — never a fabricated exact count for a block on 50+ pages.
      const pages = `${b.pageCountIsFloor ? "at least " : ""}${b.pageCount} page${b.pageCount === 1 ? "" : "s"}`;
      return `- ${b.blockName} ("${b.label}", on ${pages})`;
    })
    .join("\n");
  const shells = [
    siteMap.shell.header ? "header" : null,
    siteMap.shell.footer ? "footer" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const tokenLines = [
    ...siteMap.tokens.colors.map((c) => `- color "${c.slug}" (currently ${c.color})`),
    ...siteMap.tokens.fonts.map((f) => `- font "${f.slug}" (currently ${f.fontFamily})`),
    ...siteMap.tokens.sizes.map((s) => `- size "${s.slug}" (currently ${s.size})`),
  ].join("\n");
  const tokensSection = `

## Global design tokens (scope="tokens"; no block target)
These brand tokens apply site-wide. To change one, set scope="tokens", leave
target as a short label (e.g. "color:primary"), and fill tokenDelta with the
EXACT slug(s) below and the new value(s). regenerationPrompt is unused for tokens.
${tokenLines || "(no editable tokens captured)"}

Examples:
- "make the brand color red" → scope="tokens", tokenDelta={colors:[{slug:"primary",color:"#c00"}]}
- "use a bigger heading font size" → scope="tokens", tokenDelta={fontSizes:[{slug:"<the heading size slug above>",size:"<larger value>"}]}
A token change restyles every component that uses that token. Pick the slug whose
current value best matches what the user means; if no slug fits, ask a clarifying question.`;
  return `You are the JAB site-edit planner. The user wants to change ONE part of their generated website. Resolve their request into a single structured edit by calling the ${EDIT_PLAN_TOOL_SCHEMA.name} tool.

You may ONLY target one of these regenerable units (a block component, a shell, or a global design token):

## Block components (scope="component"; target = the exact block_name)
${blockLines || "(none)"}

## Site chrome (scope="shell"; target = "header" or "footer")
Present: ${shells || "(none)"}
${tokensSection}

Rules:
- Pick exactly ONE target. For component/shell the target MUST be one of the block_names or shell kinds above — never invent a name. For tokens use the EXACT token slug(s) above.
- If the request is vague ("make it nicer"), names something not in the lists, or could mean several units, set needsClarification=true and ask a specific question listing the real candidates. Do NOT guess.
- A block component is shared across every page it appears on. State the real blast radius in "action" (e.g. "Regenerate the Cover block — this changes it on every page that uses it").
- "regenerationPrompt" is concrete instructions for the code generator (what to change visually/structurally). Keep it focused on this one unit. It is unused for scope="tokens".
- You cannot create pages, delete content, change routing, or edit arbitrary files. Only regenerate one existing unit or change one design token.`;
}

// Exported for unit testing the prompt's blast-radius phrasing.
export function buildSystemPromptForTest(siteMap: SiteMap): string {
  return buildSystemPrompt(siteMap);
}

/**
 * Cache-stable history trim. A naive slice(-max) shifts the window start on
 * EVERY turn once history exceeds max, changing messages[0] each turn and
 * invalidating the prompt-cache prefix. Dropping the head in fixed chunks of
 * `chunk` keeps the window start stable for `chunk` consecutive turns, so
 * cache hits accrue between shifts (the prefix only re-writes once per chunk).
 */
export function stableHeadSlice<T>(msgs: T[], max = 12, chunk = 4): T[] {
  if (msgs.length <= max) return msgs;
  const drop = Math.ceil((msgs.length - max) / chunk) * chunk;
  return msgs.slice(drop);
}

export async function planEdit(args: {
  messages: PlannerMessage[];
  siteMap: SiteMap;
  client: PlannerClient;
}): Promise<{ plan: EditPlan; usage: PlannerUsage; plannerMeta: PlannerCallMeta }> {
  let trimmed = stableHeadSlice(args.messages, PLANNER_MAX_TURNS);
  // The Messages API requires messages[0] to be user-role. The budget-notice
  // path writes assistant-only rows (workspace-chat writeAssistant on
  // EditBudgetError), so a conversation — and therefore a trimmed window —
  // can start with assistant turns. Drop them; they are also pure noise
  // ("You're sending messages too quickly...") the planner doesn't need.
  while (trimmed.length > 0 && trimmed[0].role === "assistant") {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.length === 0) {
    // Unreachable while the chat action persists the user message before
    // calling planEdit — this guard turns a future invariant break into an
    // actionable error instead of a cryptic Anthropic 400.
    throw new Error("planEdit: no user-role message in conversation window — cannot call planner");
  }
  const system = buildSystemPrompt(args.siteMap);
  // Pre-call cost cap (audit: the declared caps were exported but enforced
  // nowhere). estimateTokens is a deliberate cheap heuristic — no
  // count_tokens round-trip on a user-facing turn. Structural bounds keep
  // real traffic far below this; it is a tripwire against unbounded growth
  // (e.g. a giant block inventory inflating the system prompt).
  const estimatedInputTokens =
    estimateTokens(system) +
    estimateTokens(JSON.stringify(EDIT_PLAN_TOOL_SCHEMA)) +
    trimmed.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (estimatedInputTokens > PLANNER_COST_CAP_TOKENS) {
    throw new EditBudgetError(
      "planner_cost_cap",
      "This conversation has grown too large to plan against. Send a fresh, specific request describing the single change you want.",
    );
  }
  const { toolInput, usage, stopReason, retriedForMaxTokens } = await args.client.createPlan({
    system,
    messages: trimmed,
  });
  return {
    plan: parsePlannerToolUse(toolInput),
    usage,
    plannerMeta: { stopReason, retriedForMaxTokens },
  };
}

function usageOf(response: Anthropic.Message): PlannerUsage {
  const u = response.usage;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  };
}

// Mirrors component-generator's addUsage; kept separate so the planner
// doesn't grow a cross-module dependency on the generation pipeline
// (PlannerUsage and GenerateUsage are structurally identical but serve
// different persistence surfaces).
function addUsage(a: PlannerUsage, b: PlannerUsage): PlannerUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/**
 * Real Anthropic-backed PlannerClient. Forces the emit_edit_plan tool so the
 * model's only output channel is the structured plan. Uses the process-wide
 * SDK singleton (one keep-alive pool, one shared backoff state); `sdk` is
 * injectable for tests. Model resolves through getModelFor("planner") per
 * call so JAB_AI_MODEL_PLANNER works without a redeploy.
 */
export class AnthropicPlannerClient implements PlannerClient {
  private readonly sdk: Anthropic;
  constructor(opts?: { sdk?: Anthropic }) {
    this.sdk = opts?.sdk ?? getAnthropicClient();
  }

  private async request(
    args: { system: string; messages: PlannerMessage[] },
    maxTokens: number,
  ): Promise<Anthropic.Message> {
    // Prompt caching — multi-turn pattern. Two breakpoints (max 4/request):
    //  1. system block → caches tools + system (render order tools→system→
    //     messages). On small sites this span alone may sit under Sonnet
    //     4.6's 2048-token minimum cacheable prefix — the marker is then
    //     silently inert (no error), which is fine.
    //  2. last content block of the last message → the whole request prefix
    //     (tools + system + history) becomes the cached span, so turn N+1
    //     reads turn N's prefix at ~0.1x once the conversation crosses the
    //     minimum. stableHeadSlice (planEdit) keeps the window start stable
    //     so trimming doesn't invalidate the prefix every turn.
    // The markers are applied on EVERY call — including the max_tokens retry.
    const messages: Anthropic.MessageParam[] = args.messages.map((m, i) =>
      i === args.messages.length - 1
        ? {
            role: m.role,
            content: [
              {
                type: "text" as const,
                text: m.content,
                cache_control: { type: "ephemeral" as const },
              },
            ],
          }
        : { role: m.role, content: m.content },
    );
    return this.sdk.messages.create({
      model: getModelFor("planner"),
      max_tokens: maxTokens,
      system: [
        {
          type: "text" as const,
          text: args.system,
          cache_control: { type: "ephemeral" as const },
        },
      ],
      tools: [EDIT_PLAN_TOOL_SCHEMA as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: EDIT_PLAN_TOOL_SCHEMA.name },
      messages,
    });
  }

  async createPlan(args: { system: string; messages: PlannerMessage[] }): Promise<PlannerClientResult> {
    // Deliberately NO transient-error retry here (unlike the component/shell
    // generation loops): the planner sits on a user-facing chat turn, and the
    // action layer (workspace-chat) classifies thrown errors at that boundary.
    let response = await this.request(args, PLANNER_MAX_OUTPUT_TOKENS);
    let usage = usageOf(response);
    let retriedForMaxTokens = false;
    if (response.stop_reason === "max_tokens") {
      // Truncation is observable, not a blind re-roll: retry ONCE with a
      // doubled output budget, then stop.
      console.warn(
        `[edit-planner] plan truncated at max_tokens=${PLANNER_MAX_OUTPUT_TOKENS} — retrying once at ${PLANNER_RETRY_MAX_OUTPUT_TOKENS}`,
      );
      retriedForMaxTokens = true;
      response = await this.request(args, PLANNER_RETRY_MAX_OUTPUT_TOKENS);
      usage = addUsage(usage, usageOf(response));
    }
    const stopReason = (response.stop_reason ?? null) as StopReason;
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    const rawInput = toolBlock && toolBlock.type === "tool_use" ? toolBlock.input : null;
    // A max_tokens response can carry a PARTIAL-but-parseable tool input
    // (e.g. a cut-off regenerationPrompt) — never trust it: a truncated turn
    // must not dispatch a real edit. The caller (workspace-chat) surfaces a
    // DISTINCT truncation notice on stopReason === "max_tokens"; the clarify
    // payload below is only the last-resort shape for non-truncation
    // responses that somehow carry no usable tool block.
    const toolInput =
      stopReason !== "max_tokens" && rawInput && typeof rawInput === "object"
        ? (rawInput as Record<string, unknown>)
        : {
            needsClarification: true,
            clarifyingQuestion: "Could you describe the change in more detail?",
          };
    return { toolInput, usage, stopReason, retriedForMaxTokens };
  }
}
