import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";

/**
 * downloadProjectTree — recursively lists and downloads every file under
 * `builds/<buildId>/project/` from Supabase Storage.
 *
 * Returns a `Record<string, string>` mapping Storage-relative file path
 * (e.g. `"app/page.tsx"`) to UTF-8 file contents. Paths have Next.js
 * dynamic-segment encoding reversed (see `decodeNextDynamicSegments`).
 *
 * Used by:
 *   - Phase C compile gate (`compileGeneratedProject`) to materialize the
 *     project tree into a temp dir before running `tsc --noEmit`.
 *   - Phase D deploy worker to write the project tree to disk for Vercel.
 *
 * Supabase Storage `list()` is NOT recursive — it returns one "directory
 * level" at a time. This helper BFS-traverses the tree, collecting all
 * file keys, then downloads them in batches of 8.
 *
 * Dynamic segment encoding (compose-site.ts encodes before upload):
 *   __catchall_X__    ↔ [...X]
 *   __optcatchall_X__ ↔ [[...X]]
 *   __dynamic_X__     ↔ [X]
 */
export async function downloadProjectTree(buildId: string): Promise<Record<string, string>> {
  const supabase = createAdminClient();
  const projectPrefix = `builds/${buildId}/project`;

  // BFS: collect all file paths under the project prefix.
  // Supabase list() returns {name, id, metadata} — if `id` is null and
  // `metadata` is null the entry is a pseudo-folder; otherwise it's a file.
  const filePaths: string[] = [];
  const queue: string[] = [projectPrefix];

  while (queue.length > 0) {
    const folder = queue.shift()!;
    const LIMIT = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await supabase.storage
        .from(SITE_SCREENSHOTS_BUCKET)
        .list(folder, {
          limit: LIMIT,
          offset,
          sortBy: { column: "name", order: "asc" },
        });

      if (error) {
        throw new Error(
          `[download-project-tree] list("${folder}") failed for build ${buildId}: ${error.message}`,
        );
      }

      const items = data ?? [];
      for (const item of items) {
        const fullPath = `${folder}/${item.name}`;
        if (item.id === null && item.metadata === null) {
          // Pseudo-folder — descend.
          queue.push(fullPath);
        } else {
          // File entry.
          filePaths.push(fullPath);
        }
      }

      if (items.length < LIMIT) break;
      offset += LIMIT;
    }
  }

  if (filePaths.length === 0) {
    throw new Error(
      `[download-project-tree] no files found under builds/${buildId}/project/ — Phase C may not have completed`,
    );
  }

  const result: Record<string, string> = {};
  const stripPrefix = `${projectPrefix}/`;

  // Download in batches of 8 to balance throughput vs. Supabase rate limits.
  const batches: string[][] = [];
  for (let i = 0; i < filePaths.length; i += 8) {
    batches.push(filePaths.slice(i, i + 8));
  }

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (storagePath) => {
        const { data, error } = await supabase.storage
          .from(SITE_SCREENSHOTS_BUCKET)
          .download(storagePath);

        if (error || !data) {
          throw new Error(
            `[download-project-tree] download("${storagePath}") failed: ${error?.message ?? "no data"}`,
          );
        }

        const contents = await data.text();
        // Strip the `builds/<buildId>/project/` prefix and reverse encoding.
        const relativePath = storagePath.startsWith(stripPrefix)
          ? storagePath.slice(stripPrefix.length)
          : storagePath;
        const decodedPath = decodeNextDynamicSegments(relativePath);
        result[decodedPath] = contents;
      }),
    );
  }

  return result;
}

/**
 * Reverse the Next.js dynamic-segment encoding that compose-site.ts applies
 * before uploading to Supabase Storage (which rejects `[`, `]`, `.`).
 *
 *   __optcatchall_X__ → [[...X]]
 *   __catchall_X__    → [...X]
 *   __dynamic_X__     → [X]
 *
 * Order matters: optcatchall must be matched before catchall to avoid a
 * double substitution.
 */
function decodeNextDynamicSegments(filePath: string): string {
  return filePath
    .replace(/__optcatchall_([A-Za-z0-9_]+)__/g, "[[...$1]]")
    .replace(/__catchall_([A-Za-z0-9_]+)__/g, "[...$1]")
    .replace(/__dynamic_([A-Za-z0-9_]+)__/g, "[$1]");
}
