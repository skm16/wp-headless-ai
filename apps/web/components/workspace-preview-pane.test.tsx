import { describe, it, expect } from "vitest";
import { previewPaneStatusFor, isMeaningfulTransition } from "./workspace-preview-pane";
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

  it("polls while building, regardless of hasOpenEdit", () => {
    expect(previewPaneStatusFor({ kind: "building", buildId: "b", phase: "x" }, false).shouldPoll).toBe(true);
    expect(previewPaneStatusFor({ kind: "building", buildId: "b", phase: "x" }, true).shouldPoll).toBe(true);
  });

  it("polls on ready+hasOpenEdit — the dispatch→result-build window", () => {
    const ready: WorkspacePreviewState = { kind: "ready", url: "u", buildId: "b", deploymentId: "d" };
    expect(previewPaneStatusFor(ready, true).shouldPoll).toBe(true);
    expect(previewPaneStatusFor(ready, false).shouldPoll).toBe(false);
  });

  it("never polls on none/failed (no edit can be open without a ready build)", () => {
    expect(previewPaneStatusFor({ kind: "none" }, true).shouldPoll).toBe(false);
    expect(previewPaneStatusFor({ kind: "none" }, false).shouldPoll).toBe(false);
    expect(previewPaneStatusFor({ kind: "failed", buildId: "b", failedPhase: "x" }, true).shouldPoll).toBe(false);
    expect(previewPaneStatusFor({ kind: "failed", buildId: "b", failedPhase: "x" }, false).shouldPoll).toBe(false);
  });
});

describe("isMeaningfulTransition", () => {
  const ready = (url: string): WorkspacePreviewState => ({
    kind: "ready", url, buildId: "b1", deploymentId: "d1",
  });
  const building = (phase: string): WorkspacePreviewState => ({
    kind: "building", buildId: "b2", phase,
  });

  it("kind change is meaningful", () => {
    expect(isMeaningfulTransition(ready("u"), building("Queued"), false, false)).toBe(true);
  });

  it("building phase change is meaningful", () => {
    expect(isMeaningfulTransition(building("Queued"), building("Composing the site"), false, false)).toBe(true);
  });

  it("ready url change is meaningful (edit build's preview superseded the old one)", () => {
    expect(isMeaningfulTransition(ready("https://old"), ready("https://new"), false, false)).toBe(true);
  });

  it("hasOpenEdit flip is meaningful in both directions", () => {
    expect(isMeaningfulTransition(ready("u"), ready("u"), false, true)).toBe(true);
    expect(isMeaningfulTransition(ready("u"), ready("u"), true, false)).toBe(true);
  });

  it("identical state + flag is not meaningful", () => {
    expect(isMeaningfulTransition(ready("u"), ready("u"), false, false)).toBe(false);
    expect(isMeaningfulTransition(building("Queued"), building("Queued"), true, true)).toBe(false);
  });
});
