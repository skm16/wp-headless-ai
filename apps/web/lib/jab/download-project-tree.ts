import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

/**
 * Phase D project-tree download + dynamic-route decode helper.
 *
 * Inverse of Phase C's encodeNextDynamicSegments in compose-site.ts:
 *   __catchall_X__   ↔ [...X]
 *   __optcatchall_X__ ↔ [[...X]]
 *   __dynamic_X__    ↔ [X]
 *
 * Supabase Storage rejects bracket characters in object keys, so Phase C
 * writes the encoded names. We reverse them in-memory before sending paths
 * to Vercel — Vercel and the emitted Next.js project both need real
 * bracket-segment names on disk.
 */

export function decodeNextDynamicSegments(filePath: string): string {
  return filePath
    .replace(/__optcatchall_([A-Za-z0-9_]+)__/g, "[[...$1]]")
    .replace(/__catchall_([A-Za-z0-9_]+)__/g, "[...$1]")
    .replace(/__dynamic_([A-Za-z0-9_]+)__/g, "[$1]");
}

/**
 * The decoded paths that MUST be present in the downloaded tree.
 * If any is missing, Phase C wrote a malformed project tree — we should
 * hard-fail BEFORE calling Vercel rather than waste a deployment slot.
 *
 * Subset of smoke-compose-site.ts REQUIRED_FILES: the files whose absence
 * would cause `next build` to abort immediately. The smoke runner checks
 * a richer 28-file set; this runtime gate is the minimum-viable.
 */
export const REQUIRED_DEPLOY_FILES = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "app/layout.tsx",
  "app/page.tsx",
  "components/blocks/_dispatcher.tsx",
  "components/blocks/_passthrough.tsx",
];

export function assertRequiredFiles(paths: string[]): void {
  const present = new Set(paths);
  const missing = REQUIRED_DEPLOY_FILES.filter((f) => !present.has(f));
  if (missing.length > 0) {
    throw new Error(
      `download-project-tree: missing required file(s) — Phase C output is malformed: ${missing.join(", ")}`,
    );
  }
}

export interface ProjectTreeFile {
  file: string;
  data: string;
  encoding: "utf-8";
}

/**
 * Walks builds/<buildId>/project/ recursively. Returns all files with
 * their (decoded) destination paths and UTF-8 contents, ready to hand to
 * VercelClient.createDeployment.
 *
 * Supabase Storage's `list` is shallow — items with `id === null` are
 * folders, items with an `id` are files. We recurse into folders.
 */
export async function downloadProjectTree(
  supabase: SupabaseClient,
  buildId: string,
): Promise<ProjectTreeFile[]> {
  const rootPrefix = `builds/${buildId}/project/`;
  const collected: ProjectTreeFile[] = [];

  async function walk(prefix: string, relPath: string): Promise<void> {
    const { data, error } = await supabase.storage
      .from(SITE_SCREENSHOTS_BUCKET)
      .list(prefix, { limit: 1000 });
    if (error) throw new Error(`download-project-tree: list '${prefix}' failed: ${error.message}`);
    for (const item of data ?? []) {
      const childRel = relPath ? `${relPath}/${item.name}` : item.name;
      if (item.id === null) {
        // folder
        await walk(`${prefix}${item.name}/`, childRel);
      } else {
        const objPath = `${prefix}${item.name}`;
        const { data: blob, error: dlErr } = await supabase.storage
          .from(SITE_SCREENSHOTS_BUCKET)
          .download(objPath);
        if (dlErr || !blob) {
          throw new Error(
            `download-project-tree: download '${objPath}' failed: ${dlErr?.message ?? "no blob"}`,
          );
        }
        const text = await blob.text();
        collected.push({
          file: decodeNextDynamicSegments(childRel),
          data: text,
          encoding: "utf-8",
        });
      }
    }
  }

  await walk(rootPrefix, "");
  return collected;
}
