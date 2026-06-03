import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { extractProjectDesign } from "@/lib/inngest/functions/extract-project-design";
import { discoverSite } from "@/lib/inngest/functions/discover-site";
import { generateComponents } from "@/lib/inngest/functions/generate-components";
import { composeSite } from "@/lib/inngest/functions/compose-site";
import { deploySite } from "@/lib/inngest/functions/deploy-site";
import { verifyFidelity } from "@/lib/inngest/functions/verify-fidelity";

/**
 * Inngest webhook endpoint. Discovers our registered functions for the dev
 * + cloud runtimes via GET/PUT/POST exposed by `serve()`.
 *
 * Stage 1 v2: registered `discoverSite` for Phase A discovery.
 * Stage 2 v2: registered `generateComponents` for Phase B generation.
 * Stage 3 v2: registered `composeSite` for Phase C composition.
 * Stage 4 v2: registered `deploySite` for Phase D build & deploy.
 * Stage 5 v2 (Phase 4 of the 2026-06-02 SaaS-app completion plan):
 *   registered `verifyFidelity` for Phase E fidelity scoring.
 * Stage 7 will add the `siteBuild` top-level orchestrator.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [extractProjectDesign, discoverSite, generateComponents, composeSite, deploySite, verifyFidelity],
});
