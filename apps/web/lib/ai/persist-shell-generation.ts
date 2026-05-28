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
