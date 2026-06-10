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
    // Retry with exponential backoff. Supabase Storage occasionally returns
    // 502 Bad Gateway from its edge under load — a transient infra error,
    // not a code error. upsert:true makes the upload idempotent so retries
    // are safe. Total budget: 3 attempts, ~1.2s max wait — short enough not
    // to skew Inngest step timing observably.
    const buf = Buffer.from(component.tsx, "utf8");
    // Supabase Storage allowlist does exact-string MIME matching — sending
    // "text/plain; charset=utf-8" against an allowlist of "text/plain" is
    // a hard reject. The Buffer is already UTF-8 by construction so the
    // charset parameter is redundant. Keep contentType bare.
    let lastError: { message: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { error: uploadError } = await supabase.storage
        .from(SITE_SCREENSHOTS_BUCKET)
        .upload(path, buf, { contentType: "text/plain", upsert: true });
      if (!uploadError) {
        lastError = null;
        break;
      }
      lastError = uploadError;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 200 * Math.pow(3, attempt))); // 200ms, 600ms
      }
    }
    if (lastError) {
      throw new Error(
        `[persist-generation] Storage upload failed for ${component.blockName} after 3 attempts: ${lastError.message}`,
      );
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
      // The API's usage.input_tokens is ALREADY the uncached remainder —
      // total prompt = input + cache_creation + cache_read. The previous
      // `inputTokens - cacheReadTokens` double-subtracted reads and would go
      // negative once caching works. Cost = 1.0x uncached + 1.25x creation
      // + 0.1x cached, computed at the dashboard layer.
      input_tokens_uncached: component.inputTokens,
      input_tokens_cache_creation: component.cacheCreationTokens,
      output_tokens: component.outputTokens,
      compile_status: component.compileStatus,
      compile_attempt_count: component.compileAttemptCount,
      failure_kind: component.failureKind,
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
