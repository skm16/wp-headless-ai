import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { displayDomainFrom } from "@/lib/derive";
import { loadLatestBuildForWorkspace } from "@/lib/jab/load-build-for-workspace";
import { loadProjectBuildState } from "@/lib/jab/load-project-builds";
import { loadWorkspaceEditHistory } from "@/lib/jab/load-workspace-edit-history";
import { requestWorkspaceEditAction } from "@/lib/actions/workspace-edit";
import type { WorkspaceEditScope } from "@/lib/jab/workspace-edit-validation";
import {
  WorkspaceJabDemo,
  type WorkspaceProject,
} from "@/app/ui-kit/workspace-jab/workspace-jab-demo";
import { deriveWorkspacePreviewState } from "@/lib/jab/workspace-preview-state";
import {
  assertPreviewReachable,
  PreviewProtectedError,
} from "@/lib/vercel/preview-protection";
import { ChatPanel } from "./ChatPanel";
import { loadConversation } from "@/lib/actions/workspace-chat";
import { discardEditAction } from "@/lib/actions/discard-edit";
import {
  deriveEditUiState,
  type EditUiLabel,
} from "@/lib/jab/workspace-edit-state";
import { DraftHistoryControls } from "./DraftHistoryControls";
import { MAX_PROMPT_CHARS } from "@/lib/jab/workspace-edit-validation";
import { OPEN_EDIT_STATUSES } from "@/lib/jab/open-edits";
import { autoFailStaleOpenEdits } from "@/lib/db/auto-fail-stale-open-edits";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Workspace — JAB",
  robots: { index: false, follow: false },
};

/**
 * Per-project workspace. Reuses the same UI shell as the stakeholder demo
 * at `/ui-kit/workspace-jab`, but injects real data via the `project` prop:
 *
 *   • topbar back-link → project name (links back to /projects/[id])
 *   • URL chips        → project's WordPress display domain
 *   • preview iframe   → live Vercel preview via WorkspacePreviewPane
 *                        (spec §3.2). previewState is derived from
 *                        loadProjectBuildState; the pane loads the preview
 *                        deployment URL with a device toggle and refreshes
 *                        building→ready via a 5s poll (no full reload).
 *
 * Everything else (AI panel conversation, code panel templates, WP panel
 * mocks) stays mocked for now — matches the brand doc's "real data +
 * mocked extras" pattern from the Site Detail page. Those slots will go
 * real as the relevant tables land.
 *
 * RLS makes cross-tenant probing indistinguishable from "doesn't exist":
 * if the project belongs to another tenant, supabase returns 0 rows with
 * `code: "PGRST116"`. We surface as 404 in both cases so an attacker
 * can't enumerate IDs to discover other tenants' project IDs — same
 * posture as the project page itself.
 */
export default async function ProjectWorkspace({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, wp_url")
    .eq("id", id)
    .single();

  if (error?.code === "PGRST116" || !project) notFound();
  if (error) throw error;

  // Best-effort load of the latest completed Phase B build. Null when the
  // project hasn't been generated yet — workspace falls back to the demo's
  // mocked Code panel templates in that case. Tenant access was validated
  // by the RLS-enforced projects query above; the loader uses admin client
  // (service role) because the site-screenshots bucket lacks an authenticated
  // read policy. The projectId filter is the security boundary here.
  const build = await loadLatestBuildForWorkspace(project.id);
  const buildState = await loadProjectBuildState(supabase, project.id);
  // Flip stranded edits to a visible Failed chip before loading history —
  // authorization was proven by the RLS project SELECT above (the sweep
  // itself uses the admin client).
  await autoFailStaleOpenEdits(project.id);

  const editHistory = await loadWorkspaceEditHistory(project.id, 10);

  // An open edit at render time wakes the preview pane's poll loop even
  // though the derived preview state is still 'ready' (the edit's result
  // build doesn't exist yet). Derived from the already-loaded history —
  // no extra query.
  const hasOpenEdit = editHistory.some((e) =>
    (OPEN_EDIT_STATUSES as readonly string[]).includes(e.status),
  );

  // Chat panel — gated behind JAB_CHAT_EDIT=1 (spec §3.3).
  const chatEnabled = process.env.JAB_CHAT_EDIT === "1";
  const conversation = chatEnabled
    ? await loadConversation(project.id)
    : { conversationId: null, messages: [] };

  // Spec §3.2: derive the preview pane's state from the already-loaded
  // buildState (no extra query). The protection probe is fail-soft — a
  // protected preview shows a banner, never blanks the workspace.
  const previewState = deriveWorkspacePreviewState(buildState);
  let previewProtected = false;
  if (previewState.kind === "ready") {
    try {
      await assertPreviewReachable(previewState.url);
    } catch (err) {
      if (err instanceof PreviewProtectedError) {
        previewProtected = true;
        console.warn(`[workspace] ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  const workspaceProject: WorkspaceProject = {
    id: project.id,
    name: project.name,
    displayDomain: displayDomainFrom(project.wp_url),
    previewState,
    previewProtected,
    hasOpenEdit,
    build,
  };

  // Key the edit surface off the latest READY build, not the latest build:
  // a failed/discarded edit build must not lock chat + edits + preview
  // (2026-06-09 review, high #7).
  const sourceBuildId = buildState.latestReadyBuild?.id ?? null;

  const submitEdit = async (formData: FormData) => {
    "use server";
    const scope = formData.get("scope");
    const target = formData.get("target");
    const prompt = formData.get("prompt");
    if (
      typeof scope !== "string" ||
      typeof target !== "string" ||
      typeof prompt !== "string"
    ) {
      throw new Error("submitEdit: scope/target/prompt missing");
    }
    if (!sourceBuildId) {
      throw new Error(
        "Targeted edits require a ready build. Trigger Build site first.",
      );
    }
    await requestWorkspaceEditAction({
      projectId: project.id,
      sourceBuildId,
      scope: scope as WorkspaceEditScope,
      target,
      prompt,
    });
  };

  const discardEditFormAction = async (formData: FormData) => {
    "use server";
    const editId = formData.get("editId");
    if (typeof editId !== "string") throw new Error("discard: editId missing");
    await discardEditAction({ editId });
  };

  return (
    <WorkspaceJabDemo
      project={workspaceProject}
      editsSurface={
        <WorkspaceEditsPanel
          projectId={project.id}
          sourceBuildId={sourceBuildId}
          history={editHistory}
          submitAction={submitEdit}
          discardAction={discardEditFormAction}
        />
      }
      chatSurface={
        chatEnabled ? (
          <ChatPanel
            projectId={project.id}
            initialMessages={conversation.messages}
            sourceBuildReady={sourceBuildId !== null}
          />
        ) : undefined
      }
    />
  );
}

interface WorkspaceEditsPanelProps {
  projectId: string;
  sourceBuildId: string | null;
  history: Awaited<ReturnType<typeof loadWorkspaceEditHistory>>;
  submitAction: (formData: FormData) => Promise<void>;
  discardAction: (formData: FormData) => Promise<void>;
}

function WorkspaceEditsPanel({
  projectId,
  sourceBuildId,
  history,
  submitAction,
  discardAction,
}: WorkspaceEditsPanelProps) {
  // Identify active (non-undone) completed draft steps for undo/revert controls.
  // Ordered newest-first (matches loadWorkspaceEditHistory sort order).
  const activeDraftSteps = history.filter(
    (e) => e.draftId !== null && e.status === "completed" && e.undoneAt === null,
  );
  const latestActiveDraftStepId = activeDraftSteps[0]?.id ?? null;
  const hasDraftSteps = activeDraftSteps.length > 0;

  return (
    <section className="flex h-full flex-col overflow-hidden bg-surf">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-bord px-3.5">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(0 201 167)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
        <span className="text-[13px] font-bold text-wht">Targeted edits</span>
        {!sourceBuildId && (
          <span className="ml-auto font-mono text-[11px] text-amb">
            Requires a ready build
          </span>
        )}
        {hasDraftSteps && (
          <span className="ml-auto">
            <DraftHistoryControls
              projectId={projectId}
              editId={latestActiveDraftStepId!}
              kind="discard"
            />
          </span>
        )}
      </div>

      <form action={submitAction} className="flex flex-col gap-2 px-3.5 py-3">
        <select
          name="scope"
          defaultValue="shell"
          disabled={!sourceBuildId}
          className="h-9 rounded-md border border-bord bg-elev px-2.5 text-[13px] text-wht outline-none focus:border-teal disabled:opacity-60"
        >
          <option value="shell">shell</option>
          <option value="component">component</option>
        </select>
        <input
          type="text"
          name="target"
          placeholder="header / footer / core/heading"
          disabled={!sourceBuildId}
          className="h-9 rounded-md border border-bord bg-elev px-2.5 text-[13px] text-wht outline-none focus:border-teal disabled:opacity-60"
        />
        <textarea
          name="prompt"
          placeholder="Describe the change you want"
          disabled={!sourceBuildId}
          maxLength={MAX_PROMPT_CHARS}
          rows={3}
          className="resize-none rounded-md border border-bord bg-elev px-2.5 py-2 text-[13px] leading-[1.5] text-wht outline-none focus:border-teal disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!sourceBuildId}
          className="inline-flex h-9 items-center justify-center rounded-md bg-teal px-4 text-[13px] font-semibold text-bg transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Run edit →
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3">
        {history.length > 0 && (
          <ul className="divide-y divide-bord overflow-hidden rounded-lg border border-bord bg-bg">
            {history.map((edit) => {
              // §3.4 state machine: workspace_edits.status='completed' means
              // "dispatched", not "done" — label + gates derive from the
              // LINKED build's status via deriveEditUiState.
              const isUndone = edit.undoneAt !== null;
              const ui = deriveEditUiState({
                editStatus: edit.status,
                buildStatus: edit.resultBuildStatus,
                promoted: edit.promoted,
              });
              const canReview = Boolean(edit.resultBuildId) && ui.awaitingReview;
              const canDiscard =
                ui.awaitingReview ||
                ui.label === "Building…" ||
                ui.label === "Submitting…";

              const isDraftStep = edit.draftId !== null;
              const isLatestActiveDraftStep =
                isDraftStep && !isUndone && edit.id === latestActiveDraftStepId;
              const isEarlierActiveDraftStep =
                isDraftStep && !isUndone && edit.id !== latestActiveDraftStepId;
              // Undone draft steps get a Restore control (calls revertToVersionAction).
              const isUndoneRestorableDraftStep = isDraftStep && isUndone;

              return (
                <li
                  key={edit.id}
                  className={`flex flex-col gap-1.5 px-3 py-2.5 text-[13px]${isUndone ? " opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 rounded-sm border border-bord bg-elev px-1.5 py-0.5 font-mono text-[10px] text-gry">
                      {edit.scope}/{edit.target}
                    </span>
                    {isUndone ? (
                      <span className="shrink-0 rounded-full border border-bord/40 bg-bord/10 px-2 py-0.5 font-mono text-[10px] text-gry-d">
                        Undone
                      </span>
                    ) : (
                      <EditStatusChip label={ui.label} />
                    )}
                    {isLatestActiveDraftStep && (
                      <DraftHistoryControls
                        projectId={projectId}
                        editId={edit.id}
                        kind="undo"
                      />
                    )}
                    {isEarlierActiveDraftStep && (
                      <DraftHistoryControls
                        projectId={projectId}
                        editId={edit.id}
                        kind="revert"
                      />
                    )}
                    {isUndoneRestorableDraftStep && (
                      <DraftHistoryControls
                        projectId={projectId}
                        editId={edit.id}
                        kind="revert"
                      />
                    )}
                  </div>
                  <span className={`truncate text-gry${isUndone ? " line-through" : ""}`}>
                    {edit.prompt}
                  </span>
                  {ui.label === "Failed" && edit.errorText && (
                    <span
                      className="truncate font-mono text-[11px] text-red/80"
                      title={edit.errorText}
                    >
                      {edit.errorText}
                    </span>
                  )}
                  <div className="flex items-center gap-3">
                    {edit.resultBuildId && !canReview && (
                      <Link
                        href={`/projects/${projectId}/builds/${edit.resultBuildId}/progress`}
                        className="shrink-0 font-mono text-[11px] text-teal hover:underline"
                      >
                        view build →
                      </Link>
                    )}
                    {canReview && edit.resultBuildId && (
                      <Link
                        href={`/projects/${projectId}/builds/${edit.resultBuildId}/review`}
                        className="shrink-0 font-mono text-[11px] text-teal hover:underline"
                      >
                        Review →
                      </Link>
                    )}
                    {canDiscard && (
                      <form action={discardAction}>
                        <input type="hidden" name="editId" value={edit.id} />
                        <button
                          type="submit"
                          className="shrink-0 font-mono text-[11px] text-red hover:underline"
                        >
                          Discard
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function EditStatusChip({ label }: { label: EditUiLabel }) {
  // Tones key on the derived §3.4 label, never raw workspace_edits.status
  // ('completed' is "dispatched", not "done" — a raw-status chip showed teal
  // while the build was still in flight and permanent amber for wedged edits).
  const TONE: Record<EditUiLabel, string> = {
    Applied: "border-teal/30 bg-teal/10 text-teal",
    Live: "border-teal/30 bg-teal/10 text-teal",
    "Review ready": "border-teal/30 bg-teal/10 text-teal",
    Failed: "border-red/30 bg-red/10 text-red",
    Discarded: "border-bord/40 bg-bord/10 text-gry-d",
    "Submitting…": "border-bord bg-elev text-gry",
    "Building…": "border-bord bg-elev text-gry",
  };
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] ${TONE[label]}`}
    >
      {label}
    </span>
  );
}
