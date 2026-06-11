import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUniqueViolation } from "@/lib/db/pg-error";

/**
 * drafts — service-role helpers for the Live Draft tables (migration 0035).
 * One live draft per project is enforced by drafts_one_active_per_project_idx;
 * ensureActiveDraft handles the insert race by re-selecting on conflict.
 */
export interface DraftRow {
  id: string;
  base_build_id: string;
  version: number;
  status: string;
}

const DRAFT_COLUMNS = "id, base_build_id, version, status";
const LIVE_STATUSES = ["active", "publishing"];

export async function findLiveDraft(projectId: string): Promise<DraftRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("drafts")
    .select(DRAFT_COLUMNS)
    .eq("project_id", projectId)
    .in("status", LIVE_STATUSES)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findLiveDraft failed: ${error.message}`);
  return (data as DraftRow | null) ?? null;
}

export async function ensureActiveDraft(projectId: string, tenantId: string): Promise<DraftRow> {
  const existing = await findLiveDraft(projectId);
  if (existing) return existing;

  const admin = createAdminClient();
  const { data: build, error: buildErr } = await admin
    .from("site_builds")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (buildErr) throw new Error(`ensureActiveDraft build lookup failed: ${buildErr.message}`);
  if (!build) {
    throw new Error("ensureActiveDraft: no ready build to fork a draft from — run a full build first");
  }

  const { data, error } = await admin
    .from("drafts")
    .insert({ project_id: projectId, tenant_id: tenantId, base_build_id: build.id, version: 0, status: "active" })
    .select(DRAFT_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findLiveDraft(projectId);
      if (raced) return raced;
    }
    throw new Error(`ensureActiveDraft insert failed: ${error.message}`);
  }
  return data as DraftRow;
}

/** CAS version bump — the LAST write of a commit (spec §6.2.6 ordering). */
export async function bumpDraftVersion(draftId: string, expectedVersion: number): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("drafts")
    .update({ version: expectedVersion + 1, updated_at: new Date().toISOString() })
    .eq("id", draftId)
    .eq("version", expectedVersion)
    .select("id, version");
  if (error) throw new Error(`bumpDraftVersion failed: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(`bumpDraftVersion: concurrent writer moved draft ${draftId} past v${expectedVersion}`);
  }
  return (data[0] as { version: number }).version;
}

export interface DraftVersionWithTsx {
  id: string;
  unit_key: string;
  version_no: number;
  created_by_edit_id: string | null;
  tsx: string;
}

export async function loadDraftVersions(draftId: string): Promise<DraftVersionWithTsx[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("draft_unit_versions")
    .select("id, unit_key, version_no, created_by_edit_id, tsx")
    .eq("draft_id", draftId);
  if (error) throw new Error(`loadDraftVersions failed: ${error.message}`);
  return (data ?? []) as DraftVersionWithTsx[];
}

export async function loadDraftSteps(draftId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("workspace_edits")
    .select("id, status, undone_at, changed_slugs, created_at, scope, target")
    .eq("draft_id", draftId);
  if (error) throw new Error(`loadDraftSteps failed: ${error.message}`);
  return data ?? [];
}
