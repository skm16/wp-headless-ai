import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { EDIT_PLAN_TOOL_SCHEMA, type EditPlan } from "@/lib/jab/edit-plan";
import type { SiteMap } from "@/lib/jab/site-map";
import {
  EditBudgetError,
  estimateTokens,
  PLANNER_COST_CAP_TOKENS,
  PLANNER_MAX_TURNS,
} from "./edit-cost-guard";
import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";

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

export interface PlannerClientResult {
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

const PLANNER_MODEL = "claude-sonnet-4-6";

function isScope(v: unknown): v is WorkspaceEditScope {
  return v === "component" || v === "shell";
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
  };
}

function buildSystemPrompt(siteMap: SiteMap): string {
  const blockLines = siteMap.blockTypes
    .map((b) => `- ${b.blockName} ("${b.label}", appears ${b.occurrenceCount} time${b.occurrenceCount === 1 ? "" : "s"})`)
    .join("\n");
  const shells = [
    siteMap.shell.header ? "header" : null,
    siteMap.shell.footer ? "footer" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `You are the JAB site-edit planner. The user wants to change ONE part of their generated website. Resolve their request into a single structured edit by calling the ${EDIT_PLAN_TOOL_SCHEMA.name} tool.

You may ONLY target one of these regenerable units:

## Block components (scope="component"; target = the exact block_name)
${blockLines || "(none)"}

## Site chrome (scope="shell"; target = "header" or "footer")
Present: ${shells || "(none)"}

Rules:
- Pick exactly ONE target. The target MUST be one of the block_names or shell kinds above — never invent a name.
- If the request is vague ("make it nicer"), names something not in the lists, or could mean several units, set needsClarification=true and ask a specific question listing the real candidates. Do NOT guess.
- A block component is shared across every page it appears on. State the real blast radius in "action" (e.g. "Regenerate the Cover block — this changes it on every page that uses it").
- "regenerationPrompt" is concrete instructions for the code generator (what to change visually/structurally). Keep it focused on this one unit.
- You cannot create pages, delete content, change routing, or edit arbitrary files. Only regenerate one existing unit.`;
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
}): Promise<{ plan: EditPlan; usage: PlannerUsage }> {
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
  const { toolInput, usage } = await args.client.createPlan({ system, messages: trimmed });
  return { plan: parsePlannerToolUse(toolInput), usage };
}

/**
 * Real Anthropic-backed PlannerClient. Forces the emit_edit_plan tool so the
 * model's only output channel is the structured plan.
 */
export class AnthropicPlannerClient implements PlannerClient {
  private readonly sdk: Anthropic;
  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set.");
    this.sdk = new Anthropic({ apiKey });
  }

  async createPlan(args: { system: string; messages: PlannerMessage[] }): Promise<PlannerClientResult> {
    const response = await this.sdk.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 1024,
      system: args.system,
      tools: [EDIT_PLAN_TOOL_SCHEMA as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: EDIT_PLAN_TOOL_SCHEMA.name },
      messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    const rawInput = toolBlock && toolBlock.type === "tool_use" ? toolBlock.input : null;
    const toolInput =
      rawInput && typeof rawInput === "object"
        ? (rawInput as Record<string, unknown>)
        : { needsClarification: true, clarifyingQuestion: "Could you describe the change in more detail?" };
    const u = response.usage;
    return {
      toolInput,
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
