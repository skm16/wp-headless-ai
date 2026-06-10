import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * downloadProjectTree — recursively lists and downloads every file under
 * `builds/<buildId>/project/` from Supabase Storage.
 *
 * Returns an array of `{ file, data, encoding }` entries where:
 *   - `file`     — Storage-relative path with Next.js dynamic-segment
 *                  encoding reversed (see `decodeNextDynamicSegments`).
 *   - `data`     — text files: UTF-8 contents as a string;
 *                  binary files (images/fonts/media): base64-encoded bytes.
 *   - `encoding` — `"utf-8"` for text, `"base64"` for binary.
 *
 * Binary files MUST NOT be read via `Blob.text()` — that decodes the bytes as
 * UTF-8, replacing every high byte (e.g. a PNG's leading 0x89) with U+FFFD and
 * corrupting the asset (and inflating its size ~2x). Vercel's deployment API
 * accepts `encoding: "base64"` natively, so we base64 binary files end to end.
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
 *
 * The `supabase` parameter is the admin client to use (injected for
 * testability; production callers pass `createAdminClient()`).
 */
export interface ProjectFile {
  file: string;
  data: string;
  encoding: "utf-8" | "base64";
}

/**
 * File extensions whose contents are binary and must be base64-encoded rather
 * than read as UTF-8 text. SVG is deliberately excluded — it is XML text and
 * round-trips losslessly through UTF-8.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // raster images
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // media
  "mp4", "webm", "mov", "mp3", "wav", "ogg",
  // other binary
  "pdf", "zip", "gz", "wasm",
]);

/**
 * Whether a Storage path points at a binary asset (by extension). Exported for
 * unit testing.
 */
export function isBinaryProjectFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export async function downloadProjectTree(
  supabase: SupabaseClient,
  buildId: string,
): Promise<ProjectFile[]> {
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

  const result: ProjectFile[] = [];
  const stripPrefix = `${projectPrefix}/`;

  // Download in batches of 8 to balance throughput vs. Supabase rate limits.
  const batches: string[][] = [];
  for (let i = 0; i < filePaths.length; i += 8) {
    batches.push(filePaths.slice(i, i + 8));
  }

  for (const batch of batches) {
    const entries = await Promise.all(
      batch.map(async (storagePath): Promise<ProjectFile> => {
        const { data, error } = await supabase.storage
          .from(SITE_SCREENSHOTS_BUCKET)
          .download(storagePath);

        if (error || !data) {
          throw new Error(
            `[download-project-tree] download("${storagePath}") failed: ${error?.message ?? "no data"}`,
          );
        }

        // Binary assets (images/fonts/media) → base64; text → utf-8.
        // Blob.text() on binary corrupts every high byte into U+FFFD.
        const binary = isBinaryProjectFile(storagePath);
        const contents = binary
          ? Buffer.from(await data.arrayBuffer()).toString("base64")
          : await data.text();
        // Strip the `builds/<buildId>/project/` prefix and reverse encoding.
        const relativePath = storagePath.startsWith(stripPrefix)
          ? storagePath.slice(stripPrefix.length)
          : storagePath;
        const decodedPath = decodeNextDynamicSegments(relativePath);
        return { file: decodedPath, data: contents, encoding: binary ? "base64" : "utf-8" };
      }),
    );
    result.push(...entries);
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
export function decodeNextDynamicSegments(filePath: string): string {
  return filePath
    .replace(/__optcatchall_([A-Za-z0-9_]+)__/g, "[[...$1]]")
    .replace(/__catchall_([A-Za-z0-9_]+)__/g, "[...$1]")
    .replace(/__dynamic_([A-Za-z0-9_]+)__/g, "[$1]");
}

/**
 * Required files that every emitted JAB Next.js project must include.
 * Phase D asserts their presence before dispatching to Vercel.
 */
export const REQUIRED_DEPLOY_FILES: readonly string[] = [
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "app/layout.tsx",
  "app/page.tsx",
  // Every non-homepage URL resolves through these three. assertRequiredFiles
  // runs on DECODED paths (downloadProjectTree decodes __catchall_slug__ →
  // [...slug] before asserting), hence the bracket form here.
  "app/[...slug]/page.tsx",
  "app/[...slug]/route-map.ts",
  "app/[...slug]/post-type-map.ts",
];

/**
 * Assert that all required deploy files are present in `filePaths`.
 * Throws with a clear message listing the missing files if any are absent.
 */
export function assertRequiredFiles(filePaths: string[]): void {
  const missing = REQUIRED_DEPLOY_FILES.filter((f) => !filePaths.includes(f));
  if (missing.length > 0) {
    throw new Error(
      `[download-project-tree] missing required files: ${missing.join(", ")}`,
    );
  }
}

/**
 * createDownloadProjectTree — factory that returns a `downloadProjectTree`
 * bound to a freshly-created admin Supabase client. Used by server-side
 * callers that don't manage their own client (e.g. compile-generated-project).
 */
export function createDownloadProjectTree(): (buildId: string) => Promise<ProjectFile[]> {
  return (buildId: string) => downloadProjectTree(createAdminClient(), buildId);
}
