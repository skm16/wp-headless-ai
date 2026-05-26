import { describe, it, expect, vi } from "vitest";
import { InProcessRunner, type DiscoveryRunner, type DiscoveryJob } from "./discovery-runner";
import type { PageDiscoveryResult } from "./discovery-types";

describe("InProcessRunner", () => {
  it("delegates to the injected captureFn for each page", async () => {
    const captureFn = vi.fn().mockImplementation(
      async (job: DiscoveryJob): Promise<PageDiscoveryResult> => ({
        slug: job.pages[0].slug,
        post_type: job.pages[0].post_type,
        screenshotPaths: { "1280": "fake/path.png" },
        blockCapturesByViewport: { "1280": [] },
      }),
    );
    const runner: DiscoveryRunner = new InProcessRunner(captureFn);

    const result = await runner.run({
      buildId: "b1",
      projectId: "p1",
      tenantId: "t1",
      pages: [{ slug: "home", post_type: "page", url: "https://wp.example.com/" }],
    });
    expect(result).toHaveLength(1);
    expect(captureFn).toHaveBeenCalledOnce();
    expect(result[0].screenshotPaths["1280"]).toBe("fake/path.png");
  });
});
