"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PROJECT_ASSETS_BUCKET } from "@/lib/storage/bucket";

/**
 * Promote-on-signup hook for the wow-flow.
 *
 * After a user pastes a URL on `/preview`, the worker writes their generated
 * site into `anonymous_previews` keyed by an `jab_preview_session` cookie.
 * When the same browser signs up (or in), this action runs:
 *
 *   1. Find the most recent unpromoted, unexpired `anonymous_previews`
 *      row for this session cookie.
 *   2. Call `promote_anonymous_preview()` — an atomic Postgres function
 *      that claims the row AND creates the project in one transaction.
 *      The UPDATE inside the function is the serialization point: two
 *      concurrent auth events from the same browser cannot both create
 *      duplicate projects.
 *
 * Idempotent on no-op: if there's no matching preview, returns null and the
 * caller falls back to its default redirect. Safe to call unconditionally
 * after any successful auth — we don't need a `?from=preview` flag, because
 * "this browser had a preview" is itself sufficient signal.
 *
 * Privacy: the session cookie is HttpOnly + browser-bound; the worst
 * shared-browser case is "the new user gets a preview a previous user of
 * this browser generated within 24h." Not a security hole — just a slightly
 * surprising UX. Trade-off accepted.
 *
 * What this DOES do beyond the atomic claim:
 *   - Copies `anonymous_previews.generated_html` → `projects.preview_html`
 *     so the workspace and the onboarding wizard's right-rail can show the
 *     user the thing they just saved. Best-effort: a failed copy doesn't
 *     unwind the promote (the project is the load-bearing artifact; the
 *     preview HTML is recoverable context).
 *   - Moves captured assets (logo, favicon, og image) from previews/ to
 *     projects/ storage paths. See `moveCapturedAssets` below.
 *
 * What this DOES NOT do:
 *   - Copy design tokens or personality. Stage 2's post-probe Inngest
 *     worker will produce a fresh extraction from the live WordPress
 *     homepage once the user connects (see `lib/inngest/functions/
 *     extract-project-design.ts`).
 *   - Trigger a fresh generation. The user lands on the onboarding wizard
 *     and walks the four steps themselves (intent → plugin → connect →
 *     ownership) before any backend regeneration is invoked.
 */

export interface PromoteResult {
  projectId: string;
  projectName: string;
  sourceUrl: string;
}

const SESSION_COOKIE = "jab_preview_session";

export async function promoteAnonymousPreviewIfPresent(): Promise<PromoteResult | null> {
  // 1) Authenticated user (RLS-scoped — confirms there's actually a session).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    // Diagnostic — the client-component sign-in path calls this right after
    // `signInWithPassword` resolves. If the new auth cookie hasn't reached
    // the server when this runs, we'll log a "session race" here. Spike in
    // this log => move the immediate-session promote to a server route.
    if (process.env.NODE_ENV !== "test") {
      console.warn("[promote-preview] no authenticated user — session race or no signup");
    }
    return null;
  }

  // 2) Session cookie tells us which preview-row to look for.
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId || !isUuid(sessionId)) return null;

  // 3) Look up the most recent unpromoted, unexpired preview for this
  //    session via service-role (the table denies all other roles). We
  //    need the row to derive the project name; the actual *claim* happens
  //    atomically via the Postgres function in step 6.
  const admin = createAdminClient();
  const { data: previewRow, error: previewErr } = await admin
    .from("anonymous_previews")
    .select(
      "id, source_url, final_url, extract, status, generated_html, logo_storage_path, favicon_storage_path, og_image_storage_path",
    )
    .eq("session_id", sessionId)
    .is("promoted_to_project_id", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previewErr || !previewRow) return null;

  // 4) The user's default tenant (created by the handle_new_user trigger).
  //    RLS-scoped — confirms the user really owns at least one tenant_member
  //    row before we create a project under it.
  const { data: membership, error: membershipErr } = await supabase
    .from("tenant_members")
    .select("tenant_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (membershipErr || !membership) return null;

  // 5) Project name from the extract title (preferred) or hostname (fallback).
  const projectName = deriveProjectName(previewRow);
  const wpUrl = previewRow.final_url ?? previewRow.source_url;

  // 6) Atomic claim-and-create via Postgres function. The UPDATE inside
  //    the function is the serialization point — if a concurrent auth
  //    event already claimed this row, the function returns NULL and we
  //    no-op. See migration 0007 for the function body.
  const { data: projectId, error: rpcErr } = await admin.rpc(
    "promote_anonymous_preview",
    {
      p_preview_id: previewRow.id,
      p_tenant_id: membership.tenant_id,
      p_project_name: projectName,
      p_wp_url: wpUrl,
    },
  );

  if (rpcErr) {
    console.error(
      `[promote-preview] rpc failed for previewId=${previewRow.id}:`,
      rpcErr.message,
    );
    return null;
  }

  if (!projectId) {
    // Function returned null — race lost or row already promoted. Not an
    // error; the user gets sent to /dashboard by the caller.
    return null;
  }

  // Best-effort: copy the wow HTML to the project so the workspace and
  // wizard right-rail can render it. Failure here doesn't unwind the
  // promote — the project is the load-bearing artifact; preview_html
  // being null just means the wizard skips its right-side pane.
  //
  // Using the user's RLS-scoped client (not admin) is intentional: the
  // RPC just inserted this project with `tenant_id = membership.tenant_id`
  // for THIS user, so RLS lets the UPDATE through. If the user's session
  // somehow ended between the RPC and this line the UPDATE silently
  // no-ops — which is fine, the project still exists and the warn below
  // catches the legitimate-error case.
  if (previewRow.generated_html) {
    const { error: copyHtmlErr } = await supabase
      .from("projects")
      .update({ preview_html: previewRow.generated_html })
      .eq("id", projectId as string);
    if (copyHtmlErr) {
      console.warn(
        `[promote-preview] failed to copy preview_html to project ${projectId}: ${copyHtmlErr.message}`,
      );
    }
  }

  // Best-effort: move captured assets from previews/<previewId>/ to
  // projects/<projectId>/, then update the new project's storage-path
  // columns. Move failures don't unwind the promotion — the project
  // exists and is functional even if the favicon stays at the previews/
  // path (still publicly readable; the prune cron leaves promoted-row
  // assets alone via `WHERE promoted_to_project_id IS NULL`).
  await moveCapturedAssets(
    admin,
    supabase,
    previewRow.id,
    projectId as string,
    {
      logo: previewRow.logo_storage_path,
      favicon: previewRow.favicon_storage_path,
      ogImage: previewRow.og_image_storage_path,
    },
  );

  return {
    projectId: projectId as string,
    projectName,
    sourceUrl: wpUrl,
  };
}

interface PreviewAssetPaths {
  logo: string | null;
  favicon: string | null;
  ogImage: string | null;
}

/**
 * Move asset files from the previews/ prefix to the projects/ prefix and
 * persist the new paths on the project row. Per-asset best-effort —
 * individual failures are logged and the surviving paths still get
 * persisted.
 *
 * Storage move semantics: Supabase `.move()` is a server-side rename
 * (same bucket), so it's cheap. The public URLs change to match the
 * new path; the iframe srcDoc rendered into `generated_html` still
 * references the OLD previews/ URLs, but those will keep resolving
 * (the prune cron preserves storage for promoted rows). The freshly
 * generated /projects workspace will use the new projects/ URLs.
 */
async function moveCapturedAssets(
  admin: ReturnType<typeof createAdminClient>,
  scoped: Awaited<ReturnType<typeof createClient>>,
  previewId: string,
  projectId: string,
  paths: PreviewAssetPaths,
): Promise<void> {
  const newPaths: PreviewAssetPaths = {
    logo: null,
    favicon: null,
    ogImage: null,
  };

  for (const [kind, oldPath] of Object.entries(paths) as Array<
    [keyof PreviewAssetPaths, string | null]
  >) {
    if (!oldPath) continue;
    const newPath = oldPath.replace(
      `previews/${previewId}/`,
      `projects/${projectId}/`,
    );
    if (newPath === oldPath) {
      // Path didn't match the expected prefix — leave it alone, log it.
      console.warn(
        `[promote-preview] asset path "${oldPath}" didn't match previews/${previewId}/ prefix; not moving`,
      );
      newPaths[kind] = oldPath;
      continue;
    }
    const { error: moveErr } = await admin.storage
      .from(PROJECT_ASSETS_BUCKET)
      .move(oldPath, newPath);
    if (moveErr) {
      console.warn(
        `[promote-preview] failed to move ${oldPath} → ${newPath}: ${moveErr.message}`,
      );
      newPaths[kind] = oldPath;
    } else {
      newPaths[kind] = newPath;
    }
  }

  // Persist the new paths on the project row. RLS-scoped — the user owns
  // the project we just created.
  const { error: updateErr } = await scoped
    .from("projects")
    .update({
      logo_storage_path: newPaths.logo,
      favicon_storage_path: newPaths.favicon,
      og_image_storage_path: newPaths.ogImage,
    })
    .eq("id", projectId);
  if (updateErr) {
    console.warn(
      `[promote-preview] failed to persist asset paths on project ${projectId}: ${updateErr.message}`,
    );
  }
}

function deriveProjectName(row: {
  source_url: string;
  final_url: string | null;
  extract: unknown;
}): string {
  // Prefer the AI-extracted site title when present.
  if (row.extract && typeof row.extract === "object") {
    const candidate = (row.extract as { title?: unknown }).title;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().slice(0, 80);
    }
  }
  // Fallback: derive from hostname, drop common `www.` prefix.
  try {
    const u = new URL(row.final_url ?? row.source_url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "New project";
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
