"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertEditBudget, EditBudgetError, MAX_CHAT_CONTENT_CHARS } from "@/lib/ai/edit-cost-guard";
import { buildSiteMap } from "@/lib/jab/site-map";
import { planEdit, AnthropicPlannerClient, type PlannerMessage, type PlannerUsage } from "@/lib/ai/edit-planner";
import { decideChatTurnOutcome } from "@/lib/jab/chat-turn-outcome";
import { requestWorkspaceEditAction } from "@/lib/actions/workspace-edit";
import { WorkspaceEditError } from "@/lib/jab/workspace-edit-validation";
import { isUniqueViolation } from "@/lib/db/pg-error";

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
 *   7. loadPlannerMessages → planEdit (Anthropic)
 *   8. decideChatTurnOutcome (pure branch)
 *   9a. clarify → insertAssistant (needs_clarification=true) + touch updated_at
 *   9b. edit  → insertAssistant + requestWorkspaceEditAction + patch edit_id
 *       on failure → patch message content to error, needs_clarification=true
 *
 * All WRITES use the admin client after the single RLS SELECT.
 */

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  needsClarification: boolean;
  editId: string | null;
  buildId: string | null;
  createdAt: string;
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
    .select("id, role, content, needs_clarification, edit_id, build_id, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: true });
  const messages = ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    role: r.role as "user" | "assistant",
    content: String(r.content),
    needsClarification: r.needs_clarification === true,
    editId: (r.edit_id as string | null) ?? null,
    buildId: (r.build_id as string | null) ?? null,
    createdAt: String(r.created_at),
  }));
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

  // 7. Load conversation history + call the planner.
  const history = await loadPlannerMessages(admin, conversationId);
  const { plan, usage } = await planEdit({
    messages: history,
    siteMap,
    client: new AnthropicPlannerClient(),
  });

  // 8+9. Branch on outcome.
  const outcome = decideChatTurnOutcome(plan, siteMap);

  if (outcome.kind === "clarify") {
    return await writeAssistant(admin, args.projectId, tenantId, userId, {
      content: outcome.message,
      needsClarification: true,
      plan,
      usage,
      conversationId,
    });
  }

  // 9b. Edit branch — insert the assistant row, then dispatch the edit.
  const assistantRow = await insertAssistant(admin, {
    conversationId,
    projectId: args.projectId,
    content: outcome.assistantText,
    needsClarification: false,
    plan,
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
    });
    await admin.from("chat_messages").update({ edit_id: editId }).eq("id", assistantRow.id);
    revalidatePath(`/projects/${args.projectId}/workspace`);
    return { assistant: { ...assistantRow, editId } };
  } catch (err) {
    if (!(err instanceof WorkspaceEditError)) {
      // Genuine fault (DB/network) — don't mask it as a chat reply; let it
      // surface to the caller's error boundary.
      throw err;
    }
    // Intended refusal (concurrency / budget / source-not-ready) → chat reply.
    await admin
      .from("chat_messages")
      .update({ content: err.message, needs_clarification: true })
      .eq("id", assistantRow.id);
    revalidatePath(`/projects/${args.projectId}/workspace`);
    return { assistant: { ...assistantRow, content: err.message, needsClarification: true } };
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
      input_tokens_uncached:
        (args.usage?.inputTokens ?? 0) - (args.usage?.cacheReadTokens ?? 0),
      output_tokens: args.usage?.outputTokens ?? 0,
    })
    .select("id, role, content, needs_clarification, edit_id, build_id, created_at")
    .single<Record<string, unknown>>();
  if (error || !data)
    throw new Error(`insertAssistant failed: ${error?.message ?? "no row"}`);
  return {
    id: String(data.id),
    role: "assistant",
    content: String(data.content),
    needsClarification: data.needs_clarification === true,
    editId: (data.edit_id as string | null) ?? null,
    buildId: (data.build_id as string | null) ?? null,
    createdAt: String(data.created_at),
  };
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
