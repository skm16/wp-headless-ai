import "server-only";
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * triggerDiscovery — service-layer entry to Phase A.
 *
 * Creates a fresh `site_builds` row (status: queued), then dispatches the
 * `site/discover.requested` event with the new buildId. Stage 7's
 * orchestrator will wrap this; for now it's the single shared entry
 * point used by the smoke runner.
 *
 * Service-role on purpose — site_builds inserts always come from system
 * code, never from user-facing server actions (no INSERT RLS policy
 * exists per migration 0014).
 */
export async function triggerDiscovery(input: {
  projectId: string;
  tenantId: string;
}): Promise<{ buildId: string }> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("site_builds")
    .insert({
      project_id: input.projectId,
      status: "queued",
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) {
    throw new Error(`site_builds insert failed: ${error?.message ?? "no row returned"}`);
  }

  await inngest.send({
    name: "site/discover.requested",
    data: { projectId: input.projectId, tenantId: input.tenantId, buildId: data.id },
  });

  return { buildId: data.id };
}
