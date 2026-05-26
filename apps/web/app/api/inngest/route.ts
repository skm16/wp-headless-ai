import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { extractProjectDesign } from "@/lib/inngest/functions/extract-project-design";

/**
 * Inngest webhook endpoint. Discovers our registered functions for the dev
 * + cloud runtimes via GET/PUT/POST exposed by `serve()`.
 *
 * Stage 0 v2: dropped `scrapePreview` (preview path retired) and
 * `regenerateHomepage` (homepage-blob path retired). Future builds dispatch
 * `siteBuild` (Stage 7) which fans out into the per-phase workers.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [extractProjectDesign],
});
