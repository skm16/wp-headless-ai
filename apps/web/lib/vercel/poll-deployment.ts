import "server-only";
import type { VercelClient, VercelDeployment } from "./client";

/**
 * Internal poll loop with a configurable tick interval and hard maxMs cap.
 *
 * Inngest's step.run wraps this — each Phase D run does one step.run that
 * calls pollDeployment. We do not use step.sleep + per-tick step.run
 * because Vercel deployments typically take 60-180s and 10-20 step entries
 * per deployment bloats Inngest state for no clarity gain.
 *
 * Returns a tagged outcome so the caller branches on a single switch.
 */

export interface PollDeploymentOptions {
  client: VercelClient;
  deploymentId: string;
  tickMs: number;
  maxMs: number;
}

export type PollDeploymentResult =
  | { outcome: "READY"; deployment: VercelDeployment }
  | { outcome: "ERROR"; deployment: VercelDeployment }
  | { outcome: "CANCELED"; deployment: VercelDeployment }
  | { outcome: "TIMEOUT"; lastReadyState: VercelDeployment["readyState"] | "UNKNOWN" };

export async function pollDeployment(
  opts: PollDeploymentOptions,
): Promise<PollDeploymentResult> {
  const deadline = Date.now() + opts.maxMs;
  let last: VercelDeployment | null = null;
  while (Date.now() < deadline) {
    const deployment = await opts.client.getDeployment(opts.deploymentId);
    last = deployment;
    if (deployment.readyState === "READY") return { outcome: "READY", deployment };
    if (deployment.readyState === "ERROR") return { outcome: "ERROR", deployment };
    if (deployment.readyState === "CANCELED") return { outcome: "CANCELED", deployment };
    await new Promise((r) => setTimeout(r, opts.tickMs));
  }
  // "UNKNOWN" only fires when maxMs <= 0 (deadline passes before the first poll).
  return { outcome: "TIMEOUT", lastReadyState: last?.readyState ?? "UNKNOWN" };
}
