"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Domain shown in the chrome bar for non-ready states. */
  displayDomain?: string;
}

interface PaneStatus {
  status: "idle" | "deploying" | "live" | "failed";
  src?: string;
  shouldPoll: boolean;
}

/** Pure mapping from preview state -> PreviewFrame props. Unit-tested. */
export function previewPaneStatusFor(state: WorkspacePreviewState): PaneStatus {
  switch (state.kind) {
    case "ready":
      return { status: "live", src: state.url, shouldPoll: false };
    case "building":
      return { status: "deploying", shouldPoll: true };
    case "failed":
      return { status: "failed", shouldPoll: false };
    case "none":
    default:
      return { status: "idle", shouldPoll: false };
  }
}

export function WorkspacePreviewPane({
  projectId,
  initialState,
  initialProtected = false,
  displayDomain,
}: WorkspacePreviewPaneProps) {
  const [state, setState] = useState<WorkspacePreviewState>(initialState);
  const [isProtected, setIsProtected] = useState(initialProtected);
  const inFlight = useRef(false);

  const poll = useCallback(async () => {
    if (inFlight.current) return; // guard overlapping calls
    inFlight.current = true;
    try {
      const result: LoadWorkspacePreviewStateResult =
        await loadWorkspacePreviewStateAction(projectId);
      if (result.ok) {
        setState(result.state);
        setIsProtected(result.protected);
      }
    } catch {
      // Swallow transient poll errors — the next tick retries. Never blank
      // the pane on a single failed poll.
    } finally {
      inFlight.current = false;
    }
  }, [projectId]);

  const mapped = previewPaneStatusFor(state);

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
        className="m-3 flex-1"
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
