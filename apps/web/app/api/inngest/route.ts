import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { extractProjectDesign } from "@/lib/inngest/functions/extract-project-design";
import { discoverSite } from "@/lib/inngest/functions/discover-site";

/**
 * Inngest webhook endpoint. Discovers our registered functions for the dev
 * + cloud runtimes via GET/PUT/POST exposed by `serve()`.
 *
 * Stage 1 v2: registered `discoverSite` for Phase A discovery.
 * Stage 7 will add the `siteBuild` top-level orchestrator.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [extractProjectDesign, discoverSite],
});
