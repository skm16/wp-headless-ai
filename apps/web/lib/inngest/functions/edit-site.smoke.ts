/**
 * edit-site.smoke — manual end-to-end smoke for the chat edit loop (§4 step 13).
 *
 * Prereqs (all live): Inngest dev server running, .env.local pointed at the local
 * Supabase project (ajfurojjxthhzkjqttri / "JAB WP"), the Two Roads WP backend
 * reachable, Vercel token set, and a SEEDED Two Roads project with at least one
 * `ready` full build.
 *
 * Run (HUMAN ONLY — spends real API tokens + deploys):
 *   JAB_CHAT_EDIT=1 pnpm --filter @jab/web exec tsx lib/inngest/functions/edit-site.smoke.ts <projectId>
 *
 * Asserts: actionable component edit → regen → ready → carry-forward → scoped
 * review → approve → promote (prod deployment + supersede + lineage); a SHELL edit
 * changes the header tsx (guidance threaded, not a no-op); and a vague prompt yields
 * a clarifying question with NO new build.
 *
 * ── Reconciliations (verified 2026-06-04) ──────────────────────────────────────
 *
 * 1. publishBuildAction (apps/web/lib/actions/build-review.ts line 98-102):
 *    Returns PublishBuildResult { productionDeploymentId: string; productionUrl: string; supersededCount: number }.
 *    Script uses promote.productionDeploymentId + promote.supersededCount — both MATCH the real return shape exactly.
 *
 * 2. approvePageAction (build-review.ts line 63-70):
 *    Signature: approvePageAction(buildId: string, pageInventoryId: string, projectId: string): Promise<void>.
 *    Script calls approvePageAction(resultBuildId, pageRow.id, projectId) — MATCHES exactly.
 *
 * 3. buildShellStoragePath (apps/web/lib/ai/persist-shell-generation.ts line 18-24):
 *    Exported function: (buildId: string, shellKind: "header" | "footer") => string.
 *    Script passes shellKind as the string literal "header" — satisfies "header" | "footer" union.
 *
 * 4. SITE_SCREENSHOTS_BUCKET (apps/web/lib/storage/bucket.ts line 33):
 *    Exported as: export const SITE_SCREENSHOTS_BUCKET = "site-screenshots" — confirmed.
 *
 * 5. sendChatMessageAction (apps/web/lib/actions/workspace-chat.ts line 90-93):
 *    Returns SendChatMessageResult { assistant: ChatMessageView }.
 *    ChatMessageView has needsClarification: boolean and editId: string | null — both MATCH.
 *
 * 6. deployments table (migration 0014):
 *    environment CHECK IN ('preview', 'production'); status CHECK IN ('pending', 'ready', 'failed', 'superseded').
 *    Script asserts environment === "production" && status === "ready" — valid enum values.
 *
 * 7. createAdminClient (apps/web/lib/supabase/admin.ts): confirmed exported.
 *
 * 8. workspace_edits columns (migrations 0024 + 0030):
 *    changed_slugs text[], change_reason text, source_build_id uuid, result_build_id uuid,
 *    result_promoted_deployment_id uuid — all confirmed.
 *    fidelity_reports.page_inventory_id FK confirmed (migration 0014 fidelity_reports table);
 *    page_inventory has slug + id + site_build_id.
 */

// NOTE: this script imports modules that carry `import "server-only"` guards.
// Those guards throw at runtime in a non-Next.js tsx execution. The script is
// AUTHORED for typecheck validity only — the human runner is expected to set
// NODE_ENV-equivalent env conditions (or accept the server-only guard error) as
// part of the operator runbook. Typecheck (`pnpm --filter @jab/web typecheck`)
// passes because `server-only` emits no type errors.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendChatMessageAction } from "@/lib/actions/workspace-chat";
import { publishBuildAction } from "@/lib/actions/build-review";
import { approvePageAction } from "@/lib/actions/build-review";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { buildShellStoragePath } from "@/lib/ai/persist-shell-generation";

const POLL_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_TICK_MS = 5000;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

async function waitForBuildReady(buildId: string): Promise<string> {
  const admin = createAdminClient();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { data } = await admin
      .from("site_builds")
      .select("status")
      .eq("id", buildId)
      .single<{ status: string }>();
    const status = data?.status ?? "unknown";
    if (status === "ready") return status;
    if (status === "failed" || status === "cancelled") {
      throw new Error(`SMOKE FAIL: result build ${buildId} ended ${status}`);
    }
    await new Promise((r) => setTimeout(r, POLL_TICK_MS));
  }
  throw new Error(`SMOKE FAIL: result build ${buildId} not ready within timeout`);
}

async function main() {
  const projectId = process.argv[2];
  assert(projectId, "usage: tsx edit-site.smoke.ts <projectId>");
  assert(
    process.env.JAB_CHAT_EDIT === "1",
    "set JAB_CHAT_EDIT=1 to run the chat smoke",
  );
  const admin = createAdminClient();

  // ── baseline build count ────────────────────────────────────────────────────
  const { count: buildsBefore } = await admin
    .from("site_builds")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);

  // ── S1: component edit ──────────────────────────────────────────────────────
  console.log('→ sending "make the hero bolder"');
  const { assistant } = await sendChatMessageAction({
    projectId,
    content: "make the hero bolder",
  });
  assert(
    !assistant.needsClarification,
    "expected an actionable assistant reply, got a clarifying question",
  );
  assert(assistant.editId, "assistant reply should carry an editId");

  const { data: edit } = await admin
    .from("workspace_edits")
    .select("id, result_build_id, scope, target, changed_slugs")
    .eq("id", assistant.editId)
    .single<{
      id: string;
      result_build_id: string | null;
      scope: string;
      target: string;
      changed_slugs: string[] | null;
    }>();
  assert(edit?.scope === "component", `expected scope=component, got ${edit?.scope}`);

  // Poll until the edit worker links a result build.
  let resultBuildId = edit.result_build_id;
  for (let i = 0; i < 12 && !resultBuildId; i++) {
    await new Promise((r) => setTimeout(r, POLL_TICK_MS));
    const { data } = await admin
      .from("workspace_edits")
      .select("result_build_id")
      .eq("id", edit.id)
      .single<{ result_build_id: string | null }>();
    resultBuildId = data?.result_build_id ?? null;
  }
  assert(resultBuildId, "edit never linked a result build");

  console.log(`→ waiting for result build ${resultBuildId} to reach ready`);
  await waitForBuildReady(resultBuildId);

  // ── S2: carry-forward / scoped review assertions ───────────────────────────
  const { data: editAfter } = await admin
    .from("workspace_edits")
    .select("changed_slugs, change_reason")
    .eq("id", edit.id)
    .single<{ changed_slugs: string[] | null; change_reason: string | null }>();
  assert(
    editAfter?.changed_slugs && editAfter.changed_slugs.length >= 0,
    "changed_slugs should be computed",
  );
  console.log(
    `  changed_slugs=${JSON.stringify(editAfter?.changed_slugs)} reason=${editAfter?.change_reason}`,
  );

  // Verify that pages in changed_slugs are pending (not carried over as approved).
  const { data: fidelity } = await admin
    .from("fidelity_reports")
    .select("approval_status, page_inventory:page_inventory_id(slug)")
    .eq("site_build_id", resultBuildId);
  const changedSet = new Set(editAfter?.changed_slugs ?? []);
  const rows = (fidelity ?? []) as Array<{
    approval_status: string;
    page_inventory: { slug: string } | { slug: string }[] | null;
  }>;
  for (const r of rows) {
    const pi = Array.isArray(r.page_inventory)
      ? r.page_inventory[0]
      : r.page_inventory;
    const slug = pi?.slug ?? "";
    if (changedSet.has(slug)) {
      assert(
        r.approval_status === "pending",
        `changed page ${slug} should be pending, got ${r.approval_status}`,
      );
    }
  }
  console.log("  carry-forward verified (changed pages pending)");

  // ── S3: approve changed pages + publish ─────────────────────────────────────
  for (const r of rows) {
    const pi = Array.isArray(r.page_inventory)
      ? r.page_inventory[0]
      : r.page_inventory;
    const slug = pi?.slug ?? "";
    if (changedSet.has(slug)) {
      const { data: pageRow } = await admin
        .from("page_inventory")
        .select("id")
        .eq("site_build_id", resultBuildId)
        .eq("slug", slug)
        .maybeSingle<{ id: string }>();
      if (pageRow) {
        await approvePageAction(resultBuildId, pageRow.id, projectId);
      }
    }
  }

  console.log("→ publishing (promote)");
  const promote = await publishBuildAction({ buildId: resultBuildId });
  // promote.productionDeploymentId: string — from PublishBuildResult.productionDeploymentId
  // promote.supersededCount: number — from PublishBuildResult.supersededCount
  assert(
    promote.productionDeploymentId,
    "promote should return a production deployment id",
  );

  const { data: prodRow } = await admin
    .from("deployments")
    .select("id, environment, status")
    .eq("id", promote.productionDeploymentId)
    .single<{ id: string; environment: string; status: string }>();
  // deployments.environment CHECK IN ('preview', 'production') — 'production' is valid.
  // deployments.status CHECK IN ('pending', 'ready', 'failed', 'superseded') — 'ready' is valid.
  assert(
    prodRow?.environment === "production" && prodRow.status === "ready",
    "production deployment row missing or not ready",
  );

  const { data: editFinal } = await admin
    .from("workspace_edits")
    .select("result_promoted_deployment_id")
    .eq("id", edit.id)
    .single<{ result_promoted_deployment_id: string | null }>();
  assert(
    editFinal?.result_promoted_deployment_id === promote.productionDeploymentId,
    "lineage not stamped on edit",
  );
  console.log(
    `  promoted; superseded ${promote.supersededCount}; lineage stamped`,
  );

  // ── S4: shell edit — header changes (guidance threaded) ─────────────────────
  console.log('→ sending shell edit "add a phone number to the header"');
  const shellTurn = await sendChatMessageAction({
    projectId,
    content: "add a phone number to the header",
  });
  assert(
    !shellTurn.assistant.needsClarification,
    "shell edit should be actionable",
  );
  assert(shellTurn.assistant.editId, "shell edit should carry an editId");

  const { data: shellEdit } = await admin
    .from("workspace_edits")
    .select("id, scope, target, source_build_id, result_build_id")
    .eq("id", shellTurn.assistant.editId)
    .single<{
      id: string;
      scope: string;
      target: string;
      source_build_id: string | null;
      result_build_id: string | null;
    }>();
  assert(shellEdit?.scope === "shell", `expected scope=shell, got ${shellEdit?.scope}`);
  assert(shellEdit.target === "header", `expected target=header, got ${shellEdit?.target}`);
  assert(shellEdit.source_build_id, "shell edit has no source_build_id");

  // Download the source Header.tsx so we can compare post-edit.
  // buildShellStoragePath: (buildId: string, shellKind: "header" | "footer") => string
  const sourceHeaderPath = buildShellStoragePath(shellEdit.source_build_id, "header");
  const sourceHeaderDownload = await admin.storage
    .from(SITE_SCREENSHOTS_BUCKET)
    .download(sourceHeaderPath);
  const sourceHeaderTsx = sourceHeaderDownload.data
    ? await sourceHeaderDownload.data.text()
    : null;

  // Poll until the shell edit links a result build.
  let shellBuildId = shellEdit.result_build_id;
  for (let i = 0; i < 12 && !shellBuildId; i++) {
    await new Promise((r) => setTimeout(r, POLL_TICK_MS));
    const { data } = await admin
      .from("workspace_edits")
      .select("result_build_id")
      .eq("id", shellEdit.id)
      .single<{ result_build_id: string | null }>();
    shellBuildId = data?.result_build_id ?? null;
  }
  assert(shellBuildId, "shell edit never linked a result build");
  await waitForBuildReady(shellBuildId);

  const editedHeaderPath = buildShellStoragePath(shellBuildId, "header");
  const editedHeaderDownload = await admin.storage
    .from(SITE_SCREENSHOTS_BUCKET)
    .download(editedHeaderPath);
  const editedHeaderTsx = editedHeaderDownload.data
    ? await editedHeaderDownload.data.text()
    : null;

  assert(editedHeaderTsx, "edited build has no Header.tsx in Storage");
  assert(
    editedHeaderTsx !== sourceHeaderTsx,
    "shell edit produced a byte-identical header — guidance was NOT threaded into compose (no-op preview)",
  );
  console.log("  shell edit changed the header tsx (guidance threaded)");

  // ── S5: vague prompt — clarifying question, NO new build ───────────────────
  const { count: buildsMid } = await admin
    .from("site_builds")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);

  console.log('→ sending vague "make it nicer"');
  const vague = await sendChatMessageAction({
    projectId,
    content: "make it nicer",
  });
  assert(
    vague.assistant.needsClarification,
    "vague prompt should yield a clarifying question",
  );
  assert(
    !vague.assistant.editId,
    "vague prompt must not start an edit",
  );

  // Give the system a single tick to ensure no stray build was created.
  await new Promise((r) => setTimeout(r, POLL_TICK_MS));
  const { count: buildsAfterVague } = await admin
    .from("site_builds")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  assert(buildsAfterVague === buildsMid, "vague prompt must not create a build");

  console.log(
    `\nSMOKE PASS ✓  (builds before=${buildsBefore}, after vague=${buildsAfterVague})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
