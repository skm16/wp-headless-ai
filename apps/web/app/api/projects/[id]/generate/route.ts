import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { inngest } from "@/lib/inngest/client";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/projects/:id/generate
 *
 * Kicks off an AI page-generation job. Body is a JSON object:
 *   { pagePath: string }   // "/" for the homepage; future-proof for /about etc.
 *
 * Flow:
 *   1. Validate the user owns the project. RLS on the projects table does
 *      this for us — selecting by id with a non-service-role client returns
 *      0 rows (PGRST116) if the project belongs to a different tenant.
 *   2. Validate the project is ready (status = 'ready' = onboarding done,
 *      manifest captured, GitHub creds stored).
 *   3. Insert a generation_jobs row in 'queued' status. RLS WITH CHECK
 *      verifies the project_id is in the user's tenant.
 *   4. Send the Inngest event with the job + project IDs. The worker takes
 *      it from there and updates the row as it progresses.
 *   5. Return 202 + the job id so the UI can poll status.
 *
 * Why a separate route instead of a server action? Server actions are great
 * for form submissions but awkward for "fire and poll" patterns where the
 * caller wants the inserted ID immediately and doesn't want to revalidate
 * the page right away. A REST route gives the UI explicit control.
 */
const Body = z.object({
  pagePath: z.string().trim().min(1).default("/"),
});

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return NextResponse.json({ error: "invalid project id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors.map((e) => e.message).join("; ") },
      { status: 400 },
    );
  }
  const { pagePath } = parsed.data;

  const supabase = await createClient();

  const { data: project, error: readErr } = await supabase
    .from("projects")
    .select("id, status, github_repo_full_name, manifest")
    .eq("id", projectId)
    .single();
  if (readErr) {
    if (readErr.code === "PGRST116") {
      return NextResponse.json({ error: "project not found" }, { status: 404 });
    }
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  if (project.status !== "ready") {
    return NextResponse.json(
      {
        error: `project is in status '${project.status}'; complete onboarding first`,
      },
      { status: 409 },
    );
  }
  if (!project.github_repo_full_name || !project.manifest) {
    return NextResponse.json(
      { error: "project is missing GitHub repo or manifest — re-run onboarding" },
      { status: 409 },
    );
  }

  const { data: job, error: insertErr } = await supabase
    .from("generation_jobs")
    .insert({
      project_id: projectId,
      page_path: pagePath,
      status: "queued",
    })
    .select("id")
    .single();
  if (insertErr || !job) {
    return NextResponse.json(
      { error: insertErr?.message ?? "failed to create job" },
      { status: 500 },
    );
  }

  try {
    await inngest.send({
      name: "project/generate.requested",
      data: {
        projectId,
        jobId: job.id,
        pagePath,
      },
    });
  } catch (err) {
    // Most common dev failure: Inngest dev server (localhost:8288) isn't
    // running, so the fetch refuses. Mark the job failed so the UI surfaces
    // the cause, then return a clear error code.
    const message = err instanceof Error ? err.message : String(err);
    const hint = /ECONNREFUSED|fetch failed/i.test(message)
      ? " — is `npx inngest-cli@latest dev` running in another terminal?"
      : "";
    await supabase
      .from("generation_jobs")
      .update({
        status: "failed",
        error: `Couldn't enqueue: ${message}${hint}`,
        finished_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    return NextResponse.json(
      { error: `Couldn't enqueue Inngest event: ${message}${hint}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
