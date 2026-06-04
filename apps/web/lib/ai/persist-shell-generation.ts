import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import type { GeneratedShell } from "./generate-shell";

/**
 * persist-shell-generation.ts — Phase C Header/Footer Storage + DB write.
 *
 * Mirror of persist-generation.ts:
 *   1. Upload .tsx source to Storage at
 *      builds/<id>/project/components/site/<Kind>.tsx via 3-attempt
 *      upsert with exponential backoff (200ms, 600ms). contentType is
 *      "text/plain" with NO charset suffix (MIME allowlist gotcha).
 *   2. Upsert into shell_generations with the cost telemetry from
 *      GeneratedShell.
 */

export function buildShellStoragePath(
  buildId: string,
  shellKind: "header" | "footer",
): string {
  const fileName = shellKind === "header" ? "Header.tsx" : "Footer.tsx";
  return `builds/${buildId}/project/components/site/${fileName}`;
}

/**
 * Pure decision for the JAB_SKIP_SHELL_REGEN iteration optimization.
 *
 * Compose unconditionally re-runs the shell LLM (Header + Footer) on every
 * re-compose, even when the inputs are byte-identical — pure waste when
 * iterating on per-block fixes via jab-fix-build. With the flag set we reuse
 * the prior compose's Header.tsx / Footer.tsx already in Storage.
 *
 * Carve-out: a shell-scope EDIT build whose target is this kind MUST
 * regenerate — reusing would no-op the user's requested change. And we can
 * only reuse what exists (first compose of a build has no prior artifact).
 *
 * Default (skipEnabled=false) is always false → production behaviour is
 * unchanged; the flag is a local-dev / operator-loop affordance only.
 */
export function shouldReuseShell(opts: {
  skipEnabled: boolean;
  hasEditGuidance: boolean;
  artifactExists: boolean;
}): boolean {
  return opts.skipEnabled && !opts.hasEditGuidance && opts.artifactExists;
}

/**
 * Whether a prior compose already wrote this build's shell artifact to
 * Storage. Thin IO wrapper over a Storage download (files are ~few KB).
 * Fail-soft: any error → false (regenerate rather than risk reusing nothing).
 */
export async function shellArtifactExists(
  buildId: string,
  shellKind: "header" | "footer",
): Promise<boolean> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .download(buildShellStoragePath(buildId, shellKind));
    return !error && !!data;
  } catch {
    return false;
  }
}

export interface PersistShellGenerationInput {
  buildId: string;
  projectId: string;
  shell: GeneratedShell;
}

export async function persistShellGeneration(
  input: PersistShellGenerationInput,
): Promise<{ storagePath: string }> {
  const supabase = createAdminClient();
  const { buildId, projectId, shell } = input;

  const path = buildShellStoragePath(buildId, shell.shellKind);
  const buf = Buffer.from(shell.tsx, "utf8");
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
      await new Promise((r) => setTimeout(r, 200 * Math.pow(3, attempt)));
    }
  }
  if (lastError) {
    throw new Error(
      `[persist-shell-generation] Storage upload failed for ${shell.shellKind} after 3 attempts: ${lastError.message}`,
    );
  }

  const { error: dbError } = await supabase
    .from("shell_generations")
    .upsert(
      {
        site_build_id: buildId,
        project_id: projectId,
        shell_kind: shell.shellKind,
        model_used: shell.modelUsed,
        provider_used: shell.providerUsed,
        input_tokens_cached: shell.cacheReadTokens,
        input_tokens_uncached: shell.inputTokens - shell.cacheReadTokens,
        output_tokens: shell.outputTokens,
        compile_status: shell.compileStatus,
        compile_attempt_count: shell.compileAttemptCount,
      },
      { onConflict: "site_build_id,shell_kind" },
    );

  if (dbError) {
    throw new Error(`[persist-shell-generation] shell_generations upsert failed: ${dbError.message}`);
  }

  return { storagePath: path };
}
