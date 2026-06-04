import { describe, it, expect } from "vitest";
import { previewPaneStatusFor } from "./workspace-preview-pane";
import type { WorkspacePreviewState } from "@/lib/jab/workspace-preview-state";

describe("previewPaneStatusFor", () => {
  it("maps 'ready' -> PreviewFrame status 'live' with the url", () => {
    const s: WorkspacePreviewState = {
      kind: "ready",
      url: "https://x.vercel.app",
      buildId: "b1",
      deploymentId: "d1",
    };
    const r = previewPaneStatusFor(s);
    expect(r.status).toBe("live");
    expect(r.src).toBe("https://x.vercel.app");
  });

  it("maps 'building' -> 'deploying' with no src", () => {
    const s: WorkspacePreviewState = { kind: "building", buildId: "b1", phase: "Composing the site" };
    const r = previewPaneStatusFor(s);
    expect(r.status).toBe("deploying");
    expect(r.src).toBeUndefined();
  });

  it("maps 'failed' -> 'failed' with no src", () => {
    const s: WorkspacePreviewState = { kind: "failed", buildId: "b1", failedPhase: "building" };
    const r = previewPaneStatusFor(s);
    expect(r.status).toBe("failed");
    expect(r.src).toBeUndefined();
  });

  it("maps 'none' -> 'idle' with no src", () => {
    const r = previewPaneStatusFor({ kind: "none" });
    expect(r.status).toBe("idle");
    expect(r.src).toBeUndefined();
  });

  it("only the 'building' kind should drive polling", () => {
    expect(previewPaneStatusFor({ kind: "building", buildId: "b", phase: "x" }).shouldPoll).toBe(true);
    expect(previewPaneStatusFor({ kind: "none" }).shouldPoll).toBe(false);
    expect(
      previewPaneStatusFor({ kind: "ready", url: "u", buildId: "b", deploymentId: "d" }).shouldPoll,
    ).toBe(false);
    expect(previewPaneStatusFor({ kind: "failed", buildId: "b", failedPhase: "x" }).shouldPoll).toBe(false);
  });
});
