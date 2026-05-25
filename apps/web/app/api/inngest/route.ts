import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { scrapePreview } from "@/lib/inngest/functions/scrape-preview";
import { extractProjectDesign } from "@/lib/inngest/functions/extract-project-design";
import { regenerateHomepage } from "@/lib/inngest/functions/regenerate-homepage";

/**
 * Inngest webhook endpoint. The Inngest dev server (and Inngest Cloud in
 * prod) discovers our functions by pinging this URL — `serve()` returns
 * GET (introspection / health) + PUT (function-list sync) + POST (function
 * execution) handlers in one go.
 *
 * Run the dev queue locally with:
 *   npx inngest-cli@latest dev
 * It probes http://localhost:3000/api/inngest, sees the registered
 * functions, and runs them when an event fires.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [scrapePreview, extractProjectDesign, regenerateHomepage],
});
