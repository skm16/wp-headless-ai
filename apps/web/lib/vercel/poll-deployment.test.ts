import { describe, it, expect, vi } from "vitest";
import { pollDeployment } from "./poll-deployment";
import type { VercelClient, VercelDeployment } from "./client";

function makeClient(states: VercelDeployment["readyState"][]): VercelClient {
  let i = 0;
  return {
    getDeployment: vi.fn(async () => ({
      id: "dpl_x",
      url: "x.vercel.app",
      readyState: states[Math.min(i++, states.length - 1)],
    })),
  } as unknown as VercelClient;
}

describe("pollDeployment", () => {
  it("returns READY outcome on first tick when already ready", async () => {
    const client = makeClient(["READY"]);
    const result = await pollDeployment({
      client,
      deploymentId: "dpl_x",
      tickMs: 1, // fast for tests
      maxMs: 1000,
    });
    expect(result.outcome).toBe("READY");
    if (result.outcome === "READY") {
      expect(result.deployment.url).toBe("x.vercel.app");
    }
  });

  it("polls until BUILDING → READY", async () => {
    const client = makeClient(["QUEUED", "BUILDING", "BUILDING", "READY"]);
    const result = await pollDeployment({
      client,
      deploymentId: "dpl_x",
      tickMs: 1,
      maxMs: 1000,
    });
    expect(result.outcome).toBe("READY");
    expect((client.getDeployment as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it("returns ERROR outcome when readyState is ERROR", async () => {
    const client = makeClient(["BUILDING", "ERROR"]);
    const result = await pollDeployment({
      client,
      deploymentId: "dpl_x",
      tickMs: 1,
      maxMs: 1000,
    });
    expect(result.outcome).toBe("ERROR");
  });

  it("returns TIMEOUT outcome when maxMs is exceeded", async () => {
    const client = makeClient(["QUEUED"]);
    const result = await pollDeployment({
      client,
      deploymentId: "dpl_x",
      tickMs: 5,
      maxMs: 15, // ~3 ticks
    });
    expect(result.outcome).toBe("TIMEOUT");
    if (result.outcome === "TIMEOUT") {
      expect(result.lastReadyState).toBe("QUEUED");
    }
  });
});
