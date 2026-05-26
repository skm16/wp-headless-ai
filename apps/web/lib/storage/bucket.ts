import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Supabase Storage bucket constants + idempotent bootstrap for the wow-flow
 * asset cache.
 *
 * Bucket: `project-assets`. **Public**. Contents are favicon / logo / OG
 * images that were already public on the source site; we cache them so the
 * generated preview HTML can render even if the source CDN later 404s.
 * srcDoc iframes can't authenticate, so the bucket has to allow anonymous
 * reads — there's no realistic privacy regression vs. linking to the source
 * URLs directly.
 *
 * Bootstrap is idempotent: `ensureProjectAssetsBucket()` checks for the
 * bucket and creates it only if missing. Called once per worker cold start
 * via a module-level guard — subsequent calls are a no-op pointer check.
 */

export const PROJECT_ASSETS_BUCKET = "project-assets";

/**
 * Per-build artifacts bucket. PRIVATE (unlike PROJECT_ASSETS_BUCKET) —
 * tenant-scoped build outputs. Stores both:
 *   - Phase A source + Phase E generated screenshots (`builds/<id>/source/*`,
 *     `builds/<id>/generated/*`) as PNG/JPEG.
 *   - Phase B generated component source (`builds/<id>/components/*.tsx`)
 *     as text/plain.
 * Name is historical (it was screenshot-only originally) — the bucket is
 * effectively a build-artifact store now. Path prefixes enforce separation;
 * Phase F + composer surface signed URLs to read them.
 */
export const SITE_SCREENSHOTS_BUCKET = "site-screenshots";

let _bootstrapped = false;

/**
 * Idempotently ensures the project-assets bucket exists with public read.
 * Safe to call on every worker invocation; only the first one talks to
 * Supabase. Errors propagate — capture failures should surface, not
 * silently swallow.
 *
 * `_bootstrapped` is set ONLY after we've positively confirmed the bucket
 * exists in this execution context (either getBucket found it, or our own
 * createBucket succeeded cleanly). If we hit the "already exists" race
 * branch, we re-verify via getBucket before declaring victory — that
 * branch can only be reached when something OUTSIDE this code created the
 * bucket, and we have no a-priori reason to trust its configuration.
 */
export async function ensureProjectAssetsBucket(): Promise<void> {
  if (_bootstrapped) return;

  const supabase = createAdminClient();
  const { data: existing, error: getErr } = await supabase.storage.getBucket(
    PROJECT_ASSETS_BUCKET,
  );

  if (existing) {
    _bootstrapped = true;
    return;
  }
  if (getErr && !isNotFoundError(getErr)) {
    throw new Error(
      `Failed to inspect storage bucket "${PROJECT_ASSETS_BUCKET}": ${getErr.message}`,
    );
  }

  const { error: createErr } = await supabase.storage.createBucket(
    PROJECT_ASSETS_BUCKET,
    {
      public: true,
      // 10 MB cap — well above realistic logo / favicon / OG sizes. The
      // per-asset cap in `asset-capture.ts` is tighter; this is the
      // backstop.
      fileSizeLimit: 10 * 1024 * 1024,
      allowedMimeTypes: [
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/webp",
        "image/svg+xml",
        "image/x-icon",
        "image/vnd.microsoft.icon",
      ],
    },
  );

  if (!createErr) {
    // Clean create — we authored the bucket so we know its config.
    _bootstrapped = true;
    return;
  }

  // Tolerate "already exists" — race between two cold starts, or someone
  // created the bucket outside this code. RE-VERIFY before declaring
  // bootstrapped so a misconfigured manually-created bucket doesn't sit
  // un-noticed (private when we expect public, no MIME allowlist, etc.).
  if (/already exists/i.test(createErr.message)) {
    const { data: confirmed, error: confirmErr } = await supabase.storage.getBucket(
      PROJECT_ASSETS_BUCKET,
    );
    if (confirmErr || !confirmed) {
      throw new Error(
        `Storage bucket "${PROJECT_ASSETS_BUCKET}" creation hit "already exists" but verification failed: ${confirmErr?.message ?? "no bucket returned"}`,
      );
    }
    if (!confirmed.public) {
      throw new Error(
        `Storage bucket "${PROJECT_ASSETS_BUCKET}" exists but is not public. The wow-flow needs anonymous read access for iframe srcDoc rendering. Reconfigure in Supabase dashboard or delete to let this code recreate.`,
      );
    }
    _bootstrapped = true;
    return;
  }

  throw new Error(
    `Failed to create storage bucket "${PROJECT_ASSETS_BUCKET}": ${createErr.message}`,
  );
}

/**
 * Builds a public URL for a bucket-relative storage path. Used at render
 * time to inline asset URLs into generated HTML.
 *
 * Format: `${SUPABASE_URL}/storage/v1/object/public/<bucket>/<path>`
 */
export function publicAssetUrl(storagePath: string | null | undefined): string | null {
  if (!storagePath) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) {
    console.warn("[storage] NEXT_PUBLIC_SUPABASE_URL unset — can't build public asset URL");
    return null;
  }
  // Strip leading slash if present — paths are bucket-relative.
  const clean = storagePath.replace(/^\/+/, "");
  return `${base.replace(/\/+$/, "")}/storage/v1/object/public/${PROJECT_ASSETS_BUCKET}/${clean}`;
}

function isNotFoundError(err: { message: string }): boolean {
  // supabase-js storage errors don't expose a typed not-found discriminator
  // we can rely on — match on the conventional message text. False positive
  // here would cause `createBucket` to fire on a transient error, which is
  // tolerated by the "already exists" branch in the caller.
  return /not found|does not exist/i.test(err.message);
}

let _screenshotsBootstrapped = false;

/**
 * Idempotently ensure the site-screenshots bucket exists as a PRIVATE
 * bucket. Phase A writes source/<viewport>/<slug>.png; Phase E writes
 * generated/<viewport>/<slug>.png; Phase F surfaces them via signed URLs.
 *
 * Same idempotency contract as ensureProjectAssetsBucket — including the
 * "already exists" race branch with re-verification.
 *
 * Public access is INTENTIONALLY false. Screenshots can carry draft /
 * unpublished content, dimensions of customer logos, internal URLs etc.;
 * exposing them anonymously would be a privacy regression.
 */
export async function ensureSiteScreenshotsBucket(): Promise<void> {
  if (_screenshotsBootstrapped) return;

  const supabase = createAdminClient();
  const { data: existing, error: getErr } = await supabase.storage.getBucket(
    SITE_SCREENSHOTS_BUCKET,
  );

  if (existing) {
    if (existing.public) {
      throw new Error(
        `Storage bucket "${SITE_SCREENSHOTS_BUCKET}" is public — must be private. Recreate via Supabase dashboard.`,
      );
    }
    _screenshotsBootstrapped = true;
    return;
  }
  if (getErr && !/not found|does not exist/i.test(getErr.message)) {
    throw new Error(
      `Failed to inspect storage bucket "${SITE_SCREENSHOTS_BUCKET}": ${getErr.message}`,
    );
  }

  const { error: createErr } = await supabase.storage.createBucket(
    SITE_SCREENSHOTS_BUCKET,
    {
      public: false,
      // ~25 MB per shot. Mobile-portrait full-page screenshots of long
      // landing pages can run 5–10 MB; this is a comfortable backstop.
      // The same cap applies to component .tsx files but they run <10 KB
      // (enforced by MAX_COMPONENT_BYTES in component-generator.ts).
      fileSizeLimit: 25 * 1024 * 1024,
      // text/plain accommodates the Phase B component .tsx writes.
      // Keeping the allowlist explicit (rather than null/any) prevents
      // accidental writes of arbitrary binaries into a private build bucket.
      allowedMimeTypes: ["image/png", "image/jpeg", "text/plain"],
    },
  );

  if (!createErr) {
    _screenshotsBootstrapped = true;
    return;
  }

  // Tolerate "already exists" race; re-verify the bucket is private.
  if (/already exists/i.test(createErr.message)) {
    const { data: confirmed, error: confirmErr } = await supabase.storage.getBucket(
      SITE_SCREENSHOTS_BUCKET,
    );
    if (confirmErr || !confirmed) {
      throw new Error(
        `Storage bucket "${SITE_SCREENSHOTS_BUCKET}" creation hit "already exists" but verification failed: ${confirmErr?.message ?? "no bucket returned"}`,
      );
    }
    if (confirmed.public) {
      throw new Error(
        `Storage bucket "${SITE_SCREENSHOTS_BUCKET}" exists but is public. Recreate as private.`,
      );
    }
    _screenshotsBootstrapped = true;
    return;
  }

  throw new Error(
    `Failed to create storage bucket "${SITE_SCREENSHOTS_BUCKET}": ${createErr.message}`,
  );
}
