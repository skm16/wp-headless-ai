import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import type { GeneratedComponent } from "./component-generator";

/**
 * persist-generation.ts — Phase B outputs → Storage + block_inventory.
 *
 * Two writes per generated component:
 *   1. Upload the .tsx source to Storage at builds/<build_id>/components/<Name>.tsx
 *      (uses the SITE_SCREENSHOTS_BUCKET — private, tenant-scoped).
 *   2. Update cost telemetry on block_inventory (model_used, provider_used,
 *      *_tokens, compile_status, compile_attempt_count).
 *
 * Both writes are idempotent: Storage upload uses upsert; DB update matches
 * by (site_build_id, project_id, block_name) which is unique per build.
 */

export function buildComponentStoragePath(buildId: string, blockName: string): string {
  const safeName = toPascalCase(blockName.replace(/[^a-zA-Z0-9_/]/g, "_").replace(/\//g, "_"));
  return `builds/${buildId}/components/${safeName}.tsx`;
}

export interface PersistGenerationInput {
  buildId: string;
  projectId: string;
  component: GeneratedComponent;
}

export async function persistGeneration(input: PersistGenerationInput): Promise<{ storagePath: string | null }> {
  const supabase = createAdminClient();
  const { buildId, projectId, component } = input;

  let storagePath: string | null = null;
  if (component.tsx) {
    const path = buildComponentStoragePath(buildId, component.blockName);
    const { error: uploadError } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .upload(path, Buffer.from(component.tsx, "utf8"), {
        contentType: "text/plain; charset=utf-8",
        upsert: true,
      });
    if (uploadError) {
      throw new Error(`[persist-generation] Storage upload failed for ${component.blockName}: ${uploadError.message}`);
    }
    storagePath = path;
  }

  const blockNameKey = component.blockName === "__null__" ? "__null__" : component.blockName;
  const { error: dbError } = await supabase
    .from("block_inventory")
    .update({
      model_used: component.modelUsed,
      provider_used: component.providerUsed,
      input_tokens_cached: component.cacheReadTokens,
      input_tokens_uncached: component.inputTokens - component.cacheReadTokens,
      output_tokens: component.outputTokens,
      compile_status: component.compileStatus,
      compile_attempt_count: component.compileAttemptCount,
    })
    .eq("site_build_id", buildId)
    .eq("project_id", projectId)
    .eq("block_name", blockNameKey);

  if (dbError) {
    throw new Error(`[persist-generation] block_inventory update failed for ${component.blockName}: ${dbError.message}`);
  }

  return { storagePath };
}

function toPascalCase(s: string): string {
  const pascal = s
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]+$/, "");
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}
