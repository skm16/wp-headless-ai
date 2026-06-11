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
  /**
   * sha256 over the prompt inputs (lib/jab/component-carry-forward.ts).
   * Omitted on the guidance-regen path (regenerate-unit.ts) ON PURPOSE:
   * a guidance-modified component must NULL its row's hash so no future
   * build can hash-match it.
   */
  promptInputsHash?: string | null;
  /** Set ONLY when the tsx was copied from a prior build instead of generated. */
  reusedFromBuildId?: string | null;
}

/**
 * Pure payload shaper for the block_inventory telemetry UPDATE. Extracted so
 * the column set is unit-testable without a Supabase mock. The two Phase 4
 * columns default to NULL — see PersistGenerationInput docblocks.
 *
 * @internal Exported for tests only. Production callers must go through
 * persistGeneration — constructing this payload directly bypasses the
 * Storage upload + DB update sequencing it guarantees.
 */
export function blockInventoryTelemetryPayload(
  component: GeneratedComponent,
  opts: { promptInputsHash?: string | null; reusedFromBuildId?: string | null } = {},
): Record<string, unknown> {
  return {
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
    prompt_inputs_hash: opts.promptInputsHash ?? null,
    reused_from_build_id: opts.reusedFromBuildId ?? null,
  };
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
    .update(
      blockInventoryTelemetryPayload(component, {
        promptInputsHash: input.promptInputsHash,
        reusedFromBuildId: input.reusedFromBuildId,
      }),
    )
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

/**
 * Copy a prior build's component artifact into this build's components/
 * prefix (JAB_COMPONENT_REUSE). Supabase Storage copy() fails when the
 * destination already exists (re-dispatched site/components.requested run on
 * the same build) — fall back to download + upsert upload, which is
 * idempotent. Returns false on any failure so the caller regenerates via the
 * LLM instead (fail-soft, mirroring edit-site's per-object copy tolerance).
 */
export async function copyComponentArtifact(
  supabase: ReturnType<typeof createAdminClient>,
  fromBuildId: string,
  toBuildId: string,
  blockName: string,
): Promise<boolean> {
  const from = buildComponentStoragePath(fromBuildId, blockName);
  const to = buildComponentStoragePath(toBuildId, blockName);
  const { error } = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).copy(from, to);
  if (!error) return true;
  const dl = await supabase.storage.from(SITE_SCREENSHOTS_BUCKET).download(from);
  if (dl.error || !dl.data) {
    // Surface WHY before failing soft: a transient blip and a permanently
    // missing prior artifact (Storage inconsistency) otherwise look identical
    // in the caller's "reuse copy failed — regenerating" log line.
    console.warn(
      `[persist-generation] copyComponentArtifact ${from} → ${to} failed: copy=${error.message}; download=${dl.error?.message ?? "no data"}`,
    );
    return false;
  }
  const buf = Buffer.from(await dl.data.arrayBuffer());
  const up = await supabase.storage
    .from(SITE_SCREENSHOTS_BUCKET)
    .upload(to, buf, { contentType: "text/plain", upsert: true });
  if (up.error) {
    console.warn(`[persist-generation] copyComponentArtifact fallback upload ${to} failed: ${up.error.message}`);
    return false;
  }
  return true;
}
