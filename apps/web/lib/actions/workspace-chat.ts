"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertEditBudget, EditBudgetError, MAX_CHAT_CONTENT_CHARS } from "@/lib/ai/edit-cost-guard";
import { buildSiteMap } from "@/lib/jab/site-map";
import Anthropic from "@anthropic-ai/sdk";
import { classifyAiError } from "@/lib/ai/errors";
import {
  planEdit,
  AnthropicPlannerClient,
  type PlannerClient,
  type PlannerMessage,
  type PlannerUsage,
} from "@/lib/ai/edit-planner";
import { decideChatTurnOutcome } from "@/lib/jab/chat-turn-outcome";
import { requestWorkspaceEditAction } from "@/lib/actions/workspace-edit";
import { undoLastEditAction, revertToVersionAction } from "@/lib/actions/draft-actions";
import { resolveRevertTarget } from "@/lib/jab/resolve-revert-target";
import { WorkspaceEditError } from "@/lib/jab/workspace-edit-validation";
import { isUniqueViolation } from "@/lib/db/pg-error";
import { batchRemainingFrom } from "@/lib/jab/batch-edit";

/**
 * workspace-chat — server actions for the chat surface (spec §3.3).
 *
 * Flow for sendChatMessageAction:
 *   0. Server-side JAB_CHAT_EDIT flag gate + content length cap
 *   1. RLS membership SELECT on projects (resolveProject — BEFORE budget guard)
 *   2. assertEditBudget (rate limit gate — admin reads happen only after proven membership)
 *   3. Resolve / create conversation
 *   4. Insert user message + touch conversations.updated_at
 *   5. Fetch latest 'ready' build (source build)
 *   6. buildSiteMap from source build
 *   7. loadPlannerMessages → planEdit (Anthropic) — typed-error wrapped:
 *      EditBudgetError/Anthropic.APIError → persisted assistant notice;
 *      stop_reason "max_tokens" → distinct truncation notice
 *   8. decideChatTurnOutcome (pure branch)
 *   9a. clarify → insertAssistant (needs_clarification=true) + touch updated_at
 *   9b. edit  → insertAssistant + requestWorkspaceEditAction + patch edit_id
 *       on failure → patch message content to error, needs_clarification=true
 *
 * All WRITES use the admin client after the single RLS SELECT.
 */

// One planner client per server process: shares the SDK singleton's
// keep-alive pool + backoff state (getAnthropicClient) instead of newing up
// a client per chat turn. Lazily constructed (NOT a module-scope const):
// "use server" modules may only export async functions (no test-reset
// export), and eager construction would call getAnthropicClient() at module
// evaluation — throwing at build time / on deployments without
// ANTHROPIC_API_KEY even when JAB_CHAT_EDIT is off.
let _plannerClient: PlannerClient | null = null;
function getPlannerClient(): PlannerClient {
  _plannerClient ??= new AnthropicPlannerClient();
  return _plannerClient;
}

export type WorkspaceEditStatus = "queued" | "running" | "completed" | "failed" | "discarded";

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  needsClarification: boolean;
  editId: string | null;
  buildId: string | null;
  createdAt: string;
  editStatus: WorkspaceEditStatus | null;
  editError: string | null;
  /**
   * Block names still to edit in a cross-cutting multi-block change (spec
   * 2026-07-10), derived from this message's persisted `plan.batch.remaining`.
   * `[]` for every ordinary single edit / clarify / revert / token change —
   * so the client renders plain text bubbles byte-identically to today.
   */
  batchRemaining: string[];
}

/**
 * Row → view mapping, pure + exported for test. `plan` is the persisted plan
 * JSONB; `batchRemaining` derives from `plan.batch.remaining` ([] when absent).
 */
export function chatRowToView(r: {
  id: unknown;
  role: unknown;
  content: unknown;
  needs_clarification: unknown;
  edit_id: unknown;
  build_id: unknown;
  created_at: unknown;
  plan?: unknown;
  editStatus: WorkspaceEditStatus | null;
  editError: string | null;
}): ChatMessageView {
  return {
    id: String(r.id),
    role: r.role as "user" | "assistant",
    content: String(r.content),
    needsClarification: r.needs_clarification === true,
    editId: (r.edit_id as string | null) ?? null,
    buildId: (r.build_id as string | null) ?? null,
    createdAt: String(r.created_at),
    editStatus: r.editStatus,
    editError: r.editError,
    batchRemaining: batchRemainingFrom(r.plan),
  };
}

/**
 * A dispatch refusal (WorkspaceEditError: concurrency/budget/source-not-ready)
 * must NOT overwrite the batch-echo assistant turn or flip its
 * needs_clarification (findings A+B). We surface the refusal as a SEPARATE
 * assistant notice instead. This pure helper decides the two writes.
 */
export function dispatchRefusalPlan(reason: string): {
  overwriteOriginal: false;
  noticeContent: string;
} {
  return { overwriteOriginal: false, noticeContent: reason };
}

// ── public reads ──

export async function loadConversation(
  projectId: string,
): Promise<{ conversationId: string | null; messages: ChatMessageView[] }> {
  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!conv) return { conversationId: null, messages: [] };
  const { data: rows } = await supabase
    .from("chat_messages")
    .select(
      "id, role, content, needs_clarification, edit_id, build_id, created_at, plan, edit:edit_id(status, error_text)",
    )
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });
  const messages = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => {
    const editJoin = r.edit as
      | { status: WorkspaceEditStatus; error_text: string | null }
      | { status: WorkspaceEditStatus; error_text: string | null }[]
      | null;
    const edit = Array.isArray(editJoin) ? (editJoin[0] ?? null) : editJoin;
    return chatRowToView({
      id: r.id,
      role: r.role,
      content: r.content,
      needs_clarification: r.needs_clarification,
      edit_id: r.edit_id,
      build_id: r.build_id,
      created_at: r.created_at,
      plan: r.plan,
      editStatus: edit?.status ?? null,
      editError: edit?.error_text ?? null,
    });
  });
  return { conversationId: conv.id, messages };
}

// ── public mutations ──

export interface SendChatMessageResult {
  assistant: ChatMessageView;
}

export async function sendChatMessageAction(args: {
  projectId: string;
  content: string;
}): Promise<SendChatMessageResult> {
  // Server-side flag gate — the UI gate alone left the action (Anthropic
  // spend + edit dispatch) callable with the flag off (2026-06-09 review).
  if (process.env.JAB_CHAT_EDIT !== "1") {
    throw new Error("Chat edits are disabled on this deployment (JAB_CHAT_EDIT).");
  }
  const content = args.content.trim();
  if (!content) throw new Error("Message is empty.");
  if (content.length > MAX_CHAT_CONTENT_CHARS) {
    throw new Error(
      `Message is too long (${content.length} chars; max ${MAX_CHAT_CONTENT_CHARS}).`,
    );
  }

  // 1. RLS membership SELECT FIRST — the budget guard runs service-role
  // queries and must not be reachable for arbitrary project ids.
  const { tenantId, userId } = await resolveProject(args.projectId);
  const admin = createAdminClient();

  // 2. Budget guard (admin reads now happen only after proven membership).
  try {
    await assertEditBudget({ projectId: args.projectId });
  } catch (err) {
    if (err instanceof EditBudgetError) {
      return await writeAssistant(admin, args.projectId, tenantId, userId, {
        content: err.message,
        needsClarification: true,
      });
    }
    throw err;
  }

  // 3. Resolve / create conversation.
  const conversationId = await ensureConversation(admin, args.projectId, tenantId, userId);

  // 4. Insert the user message + touch updated_at.
  // Intentionally do NOT persist the user message on budget-exceeded: the
  // rate-limit window counts chat_messages rows, so writing it would consume
  // a slot. The assistant-only notice is coherent on its own.
  const { error: userMsgErr } = await admin.from("chat_messages").insert({
    conversation_id: conversationId,
    project_id: args.projectId,
    role: "user",
    content,
  });
  if (userMsgErr) {
    // A silently-dropped user turn corrupts durable history AND the planner's
    // context — fail the action instead.
    throw new Error(`chat: failed to persist user message: ${userMsgErr.message}`);
  }
  await touchConversation(admin, conversationId);

  // 5. Source build = latest 'ready' build for this project.
  const { data: ready } = await admin
    .from("site_builds")
    .select("id")
    .eq("project_id", args.projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (!ready) {
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content:
        "There's no completed build to edit yet. Build the site first, then ask me to change something.",
      needsClarification: true,
      conversationId,
    });
  }
  const sourceBuildId = ready.id;

  // 6. Site map for the source build the edit will clone.
  const siteMap = await buildSiteMap(sourceBuildId);

  // 7. Load conversation history + call the planner. The user message is
  // already persisted at this point, so a planner failure must produce a
  // persisted assistant notice — never a dangling user turn + raw 500.
  const history = await loadPlannerMessages(admin, conversationId);
  let planned: Awaited<ReturnType<typeof planEdit>>;
  try {
    planned = await planEdit({
      messages: history,
      siteMap,
      client: getPlannerClient(),
    });
  } catch (err) {
    if (err instanceof EditBudgetError) {
      // planner_cost_cap (pre-call estimate in planEdit) → same friendly
      // notice path as the rate-limit gate above.
      return await writeAssistant(admin, args.projectId, tenantId, userId, {
        content: err.message,
        needsClarification: true,
        conversationId,
      });
    }
    if (!(err instanceof Anthropic.APIError)) {
      // Genuine fault (programming error, DB) — surface it, don't mask it
      // as a chat reply.
      throw err;
    }
    const kind = classifyAiError(err);
    console.error(`[workspace-chat] planner API failure (${kind}):`, err);
    const content =
      kind === "rate_limit" || kind === "overloaded"
        ? "The planner is overloaded right now. Wait a moment and send your request again."
        : kind === "auth"
          ? "The planner can't reach the AI service (configuration problem). An operator needs to check this deployment's ANTHROPIC_API_KEY."
          : "The planner hit a temporary problem talking to the AI service. Please try again.";
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content,
      needsClarification: true,
      conversationId,
    });
  }
  const { plan, usage, plannerMeta } = planned;
  // Telemetry mark lives INSIDE the existing chat_messages.plan jsonb (no
  // migration): the persisted object is the EditPlan plus a plannerMeta key
  // ({ stopReason, retriedForMaxTokens }).
  const planRecord: Record<string, unknown> = { ...plan, plannerMeta };

  if (plannerMeta.stopReason === "max_tokens") {
    // Truncated even after the single 2048 retry. Distinct notice — never
    // the generic clarify fallback (the user should rephrase smaller, not
    // "describe in more detail").
    console.warn(
      `[workspace-chat] planner output truncated at max_tokens even after retry (project ${args.projectId})`,
    );
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content:
        "That request was too complex to plan in one pass. Try asking for one smaller, more specific change at a time.",
      needsClarification: true,
      plan: planRecord,
      usage,
      conversationId,
    });
  }

  // 8+9. Branch on outcome.
  const outcome = decideChatTurnOutcome(plan, siteMap);

  if (outcome.kind === "clarify") {
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content: outcome.message,
      needsClarification: true,
      plan: planRecord,
      usage,
      conversationId,
    });
  }

  if (outcome.kind === "revert") {
    let replyText: string;
    if (outcome.intent === "undo_last") {
      const r = await undoLastEditAction(args.projectId);
      replyText = r.ok
        ? "Done — I undid the last change. The preview is updating."
        : r.error === "nothing_to_undo"
          ? "There's nothing to undo yet."
          : r.error === "no_draft"
            ? "There's no live draft to undo. Make an edit first."
            : r.error === "draft_locked"
              ? "This draft is publishing right now — cancel the publish first, then I can undo."
              : "I couldn't undo that. Please try again.";
    } else {
      // to_version — resolve the named version to a concrete edit id.
      const { data: editRows } = await admin
        .from("workspace_edits")
        .select("id, created_at")
        .eq("project_id", args.projectId)
        .eq("status", "completed")
        .is("undone_at", null)
        .order("created_at", { ascending: true });
      const ascending = ((editRows ?? []) as Array<{ id: string; created_at: string }>).map((r) => ({
        id: r.id,
        createdAt: r.created_at,
      }));
      const resolved =
        outcome.version === null
          ? ({ ok: false, reason: "out_of_range" } as const)
          : resolveRevertTarget(ascending, outcome.version);
      if (!resolved.ok) {
        replyText = `I couldn't find that version. There ${ascending.length === 1 ? "is 1 edit" : `are ${ascending.length} edits`} to revert to — tell me which one, or say "undo" to undo the last change.`;
      } else {
        const r = await revertToVersionAction(args.projectId, resolved.editId);
        replyText = r.ok
          ? "Done — I reverted to that version. The preview is updating."
          : r.error === "no_draft"
            ? "There's no live draft to revert. Make an edit first."
            : r.error === "draft_locked"
              ? "This draft is publishing right now — cancel the publish first, then I can revert."
              : r.error === "edit_not_found"
                ? "I couldn't find that edit to revert to."
                : "I couldn't revert that. Please try again.";
      }
    }
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content: replyText,
      needsClarification: false,
      conversationId,
    });
  }

  // 9b. Edit branch — insert the assistant row, then dispatch the edit.
  const assistantRow = await insertAssistant(admin, {
    conversationId,
    projectId: args.projectId,
    content: outcome.assistantText,
    needsClarification: false,
    plan: planRecord,
    usage,
  });
  await touchConversation(admin, conversationId);

  try {
    const { editId } = await requestWorkspaceEditAction({
      projectId: args.projectId,
      sourceBuildId,
      scope: outcome.plan.scope,
      target: outcome.plan.target,
      prompt: outcome.plan.action,
      regenerationPrompt: outcome.plan.regenerationPrompt,
      action: outcome.plan.action,
      messageId: assistantRow.id,
      tokenDelta: outcome.plan.tokenDelta,
    });
    await admin.from("chat_messages").update({ edit_id: editId }).eq("id", assistantRow.id);
    revalidatePath(`/projects/${args.projectId}/workspace`);
    return { assistant: { ...assistantRow, editId, editStatus: "queued" } };
  } catch (err) {
    if (!(err instanceof WorkspaceEditError)) {
      // Genuine fault (DB/network) — don't mask it as a chat reply; let it
      // surface to the caller's error boundary.
      throw err;
    }
    // Intended refusal (concurrency / budget / source-not-ready). Do NOT
    // overwrite the assistant echo turn (findings A+B): leave it intact so the
    // batch remaining list survives for the planner and no spurious batch chip
    // renders on the error bubble. Its edit_id stays unset (dispatch failed
    // before the edit id came back), so it correctly shows no footer. Surface
    // the reason as a SEPARATE assistant notice instead.
    const { noticeContent } = dispatchRefusalPlan(err.message);
    revalidatePath(`/projects/${args.projectId}/workspace`);
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content: noticeContent,
      needsClarification: true,
      conversationId,
    });
  }
}

// ── internal helpers ──

async function touchConversation(
  admin: ReturnType<typeof createAdminClient>,
  conversationId: string,
): Promise<void> {
  await admin
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

async function resolveProject(
  projectId: string,
): Promise<{ tenantId: string; userId: string }> {
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, tenant_id")
    .eq("id", projectId)
    .single<{ id: string; tenant_id: string }>();
  if (error?.code === "PGRST116" || !project) {
    throw new WorkspaceEditError("not_found", "Project not found.");
  }
  if (error) throw error;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");
  return { tenantId: project.tenant_id, userId: user.id };
}

async function ensureConversation(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
  tenantId: string,
  userId: string,
): Promise<string> {
  const { data: existing } = await admin
    .from("conversations")
    .select("id")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("conversations")
    .insert({ project_id: projectId, tenant_id: tenantId, created_by_user_id: userId })
    .select("id")
    .single<{ id: string }>();
  if (error) {
    if (isUniqueViolation(error)) {
      // Lost the race — the winner's row IS the thread (0032 unique index).
      const { data: winner, error: reselectErr } = await admin
        .from("conversations")
        .select("id")
        .eq("project_id", projectId)
        .maybeSingle<{ id: string }>();
      if (winner) return winner.id;
      throw new Error(
        `ensureConversation failed: lost insert race and winner re-select ${
          reselectErr ? `errored: ${reselectErr.message}` : "found no row"
        } (original: ${error.message})`,
      );
    }
    throw new Error(`ensureConversation failed: ${error.message}`);
  }
  if (!data) throw new Error("ensureConversation failed: no row");
  return data.id;
}

async function loadPlannerMessages(
  admin: ReturnType<typeof createAdminClient>,
  conversationId: string,
): Promise<PlannerMessage[]> {
  const { data } = await admin
    .from("chat_messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  return ((data ?? []) as Array<{ role: "user" | "assistant"; content: string }>).map((r) => ({
    role: r.role,
    content: r.content,
  }));
}

async function insertAssistant(
  admin: ReturnType<typeof createAdminClient>,
  args: {
    conversationId: string;
    projectId: string;
    content: string;
    needsClarification: boolean;
    plan?: unknown;
    usage?: PlannerUsage;
  },
): Promise<ChatMessageView> {
  const { data, error } = await admin
    .from("chat_messages")
    .insert({
      conversation_id: args.conversationId,
      project_id: args.projectId,
      role: "assistant",
      content: args.content,
      needs_clarification: args.needsClarification,
      plan: args.plan ?? null,
      input_tokens_cached: args.usage?.cacheReadTokens ?? 0,
      input_tokens_uncached: args.usage?.inputTokens ?? 0,
      output_tokens: args.usage?.outputTokens ?? 0,
    })
    .select("id, role, content, needs_clarification, edit_id, build_id, created_at")
    .single<Record<string, unknown>>();
  if (error || !data)
    throw new Error(`insertAssistant failed: ${error?.message ?? "no row"}`);
  return chatRowToView({
    id: data.id,
    role: "assistant",
    content: data.content,
    needs_clarification: data.needs_clarification,
    edit_id: data.edit_id,
    build_id: data.build_id,
    created_at: data.created_at,
    // The persisted plan drives batchRemaining so the just-emitted batch's
    // remaining set surfaces on this assistant view (propose + apply turns).
    plan: args.plan,
    editStatus: null,
    editError: null,
  });
}

async function writeAssistant(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
  tenantId: string,
  userId: string,
  args: {
    content: string;
    needsClarification: boolean;
    plan?: unknown;
    usage?: PlannerUsage;
    conversationId?: string;
  },
): Promise<SendChatMessageResult> {
  const conversationId =
    args.conversationId ??
    (await ensureConversation(admin, projectId, tenantId, userId));
  const assistant = await insertAssistant(admin, {
    conversationId,
    projectId,
    content: args.content,
    needsClarification: args.needsClarification,
    plan: args.plan,
    usage: args.usage,
  });
  await touchConversation(admin, conversationId);
  revalidatePath(`/projects/${projectId}/workspace`);
  return { assistant };
}
