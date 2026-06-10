"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PreviewFrame } from "@/components/preview-frame";
import type { WorkspacePreviewState } from "@/lib/jab/workspace-preview-state";
import {
  loadWorkspacePreviewStateAction,
  type LoadWorkspacePreviewStateResult,
} from "@/lib/actions/workspace-preview";

/**
 * WorkspacePreviewPane — sole owner of the workspace preview slot (spec §3.2).
 * Wraps the hardened PreviewFrame (external-`src` sandbox + device toggle +
 * scaled-iframe already built) and owns the poll-while-building effect:
 *
 *   - poll ONLY while kind === "building"
 *   - ≥5s interval
 *   - guard against overlapping in-flight calls (a slow poll never stacks)
 *   - clear on unmount / when leaving the building state
 *   - poll, NOT meta-refresh — a full reload would reset chat scroll/focus
 *     (a11y regression, §3.2)
 *
 * The building state surfaces the real phase (not a bare spinner) + a "View
 * full progress" link so a 2–3 min edit never looks hung.
 */

const POLL_INTERVAL_MS = 5_000;

export interface WorkspacePreviewPaneProps {
  projectId: string;
  /** Server-rendered initial state (from the page's already-loaded buildState). */
  initialState: WorkspacePreviewState;
  /** Whether the initial server render found the preview protected. */
  initialProtected?: boolean;
  /** Server-rendered "an edit is queued/running" flag — drives ready-state polling. */
  initialHasOpenEdit?: boolean;
  /** Domain shown in the chrome bar for non-ready states. */
  displayDomain?: string;
}

interface PaneStatus {
  status: "idle" | "deploying" | "live" | "failed";
  src?: string;
  shouldPoll: boolean;
}

/** Pure mapping from preview state -> PreviewFrame props. Unit-tested. */
export function previewPaneStatusFor(
  state: WorkspacePreviewState,
  hasOpenEdit = false,
): PaneStatus {
  switch (state.kind) {
    case "ready":
      // ready+open-edit covers the dispatch→result-build window: the edit's
      // build doesn't exist yet, so the derived state is still 'ready', but
      // we must keep polling to catch the flip to 'building'.
      return { status: "live", src: state.url, shouldPoll: hasOpenEdit };
    case "building":
      return { status: "deploying", shouldPoll: true };
    case "failed":
      return { status: "failed", shouldPoll: false };
    case "none":
    default:
      return { status: "idle", shouldPoll: false };
  }
}

/**
 * True when a polled result differs from the previous one in a way the
 * server-rendered surfaces care about (history chips, chat links). The pane
 * calls router.refresh() on these so the RSC re-renders — this is the
 * workspace's live-refresh mechanism (spec Track B3).
 */
export function isMeaningfulTransition(
  prev: WorkspacePreviewState,
  next: WorkspacePreviewState,
  prevHasOpenEdit: boolean,
  nextHasOpenEdit: boolean,
): boolean {
  if (prev.kind !== next.kind) return true;
  if (prev.kind === "building" && next.kind === "building" && prev.phase !== next.phase) return true;
  if (prev.kind === "ready" && next.kind === "ready" && prev.url !== next.url) return true;
  return prevHasOpenEdit !== nextHasOpenEdit;
}

export function WorkspacePreviewPane({
  projectId,
  initialState,
  initialProtected = false,
  initialHasOpenEdit = false,
  displayDomain,
}: WorkspacePreviewPaneProps) {
  const router = useRouter();
  const [state, setState] = useState<WorkspacePreviewState>(initialState);
  const [isProtected, setIsProtected] = useState(initialProtected);
  const [hasOpenEdit, setHasOpenEdit] = useState(initialHasOpenEdit);
  const inFlight = useRef(false);
  // Refs mirror the latest polled values so the poll callback can diff
  // without depending on state (which would re-create the interval).
  const stateRef = useRef(initialState);
  const openEditRef = useRef(initialHasOpenEdit);

  // Prop sync is OR-only: a revalidated RSC render that says "an edit is
  // open" must wake a non-polling pane (the post-submit case). It must NOT
  // force false — a concurrent revalidate computed from a slightly older
  // read could stop an active poll loop with no refresh pending to restart
  // it. Polls drive the flag back to false.
  useEffect(() => {
    if (initialHasOpenEdit) {
      setHasOpenEdit(true);
      openEditRef.current = true;
    }
  }, [initialHasOpenEdit]);

  const poll = useCallback(async () => {
    if (inFlight.current) return; // guard overlapping calls
    inFlight.current = true;
    try {
      const result: LoadWorkspacePreviewStateResult =
        await loadWorkspacePreviewStateAction(projectId);
      if (result.ok) {
        const transitioned = isMeaningfulTransition(
          stateRef.current,
          result.state,
          openEditRef.current,
          result.hasOpenEdit,
        );
        stateRef.current = result.state;
        openEditRef.current = result.hasOpenEdit;
        setState(result.state);
        setIsProtected(result.protected);
        setHasOpenEdit(result.hasOpenEdit);
        // Refresh the RSC so the edits history, chips, and chat transcript
        // re-render from fresh data (Track B3 — workspace live-refresh).
        if (transitioned) router.refresh();
      } else {
        // Project gone (not_found) — stop polling by going terminal. This drops
        // shouldPoll to false, so the effect cleanup clears the interval.
        stateRef.current = { kind: "none" };
        openEditRef.current = false;
        setState({ kind: "none" });
        setHasOpenEdit(false);
      }
    } catch {
      // Swallow transient poll errors — the next tick retries. Never blank
      // the pane on a single failed poll.
    } finally {
      inFlight.current = false;
    }
  }, [projectId, router]);

  const mapped = previewPaneStatusFor(state, hasOpenEdit);

  useEffect(() => {
    if (!mapped.shouldPoll) return;
    const id = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [mapped.shouldPoll, poll]);

  const caption =
    state.kind === "building"
      ? state.phase
      : state.kind === "failed"
        ? `Build failed at: ${state.failedPhase}`
        : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-bg">
      {isProtected && (
        <div
          role="alert"
          className="border-b border-amb/40 bg-amb/[0.08] px-4 py-2 text-[12px] text-amb"
        >
          Preview is protected — disable Deployment Protection for previews in
          Vercel, then reload.
        </div>
      )}
      <PreviewFrame
        src={mapped.src}
        url={mapped.src ?? displayDomain}
        status={mapped.status}
        caption={caption}
        title="Live preview"
        fill
        className="m-3 min-h-0 flex-1"
      />
      {state.kind === "building" && (
        <div className="px-4 pb-3 text-center text-[12px] text-gry-d">
          <Link
            href={`/projects/${projectId}/builds/${state.buildId}/progress`}
            className="font-mono text-teal hover:underline"
          >
            View full progress →
          </Link>
        </div>
      )}
    </div>
  );
}
