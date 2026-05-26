import "server-only";
import type { PageDescriptor, PageDiscoveryResult } from "./discovery-types";

/**
 * Seam between the Inngest worker and the actual Playwright execution. The
 * Stage 1 spike (Task 5) decided whether the default runner is in-process
 * (chromium inside the Inngest function) or HTTP-based (dedicated Fly /
 * Railway service holding the browser).
 *
 * The seam exists either way: even with the in-process default, production
 * load may force a dedicated-worker migration without re-architecting the
 * discovery worker. Stages 4 (next build) and 5 (verification screenshots)
 * face the same decision and can reuse this abstraction.
 */

export interface DiscoveryJob {
  buildId: string;
  projectId: string;
  tenantId: string;
  pages: PageDescriptor[];
}

export interface DiscoveryRunner {
  run(job: DiscoveryJob): Promise<PageDiscoveryResult[]>;
}

/**
 * Default runner: calls a per-job capture function in-process. The capture
 * function is injected so the runner has no direct dependency on
 * playwright-discovery — keeps the test boundary clean.
 */
export class InProcessRunner implements DiscoveryRunner {
  constructor(
    private readonly captureFn: (
      pageJob: DiscoveryJob,
    ) => Promise<PageDiscoveryResult>,
  ) {}

  async run(job: DiscoveryJob): Promise<PageDiscoveryResult[]> {
    // Per-page sequential — chromium reuse across pages is left to the
    // capture function. Parallelism, if added, lives there too because
    // it needs to bound the open-context count for memory pressure.
    const out: PageDiscoveryResult[] = [];
    for (const page of job.pages) {
      const single = await this.captureFn({ ...job, pages: [page] });
      out.push(single);
    }
    return out;
  }
}

/**
 * Future-fit: HTTP runner that delegates to a dedicated Playwright service.
 * Stub now, fleshed out only when Task 5's spike forces it. The shape exists
 * here so the Inngest worker's wiring already takes a `DiscoveryRunner`
 * interface — switching defaults is a one-line edit later.
 */
export class HttpRunner implements DiscoveryRunner {
  constructor(private readonly endpointUrl: string, private readonly signingSecret: string) {}

  async run(_job: DiscoveryJob): Promise<PageDiscoveryResult[]> {
    throw new Error(
      "HttpRunner is a stub — implement when a dedicated Playwright service exists",
    );
  }
}
