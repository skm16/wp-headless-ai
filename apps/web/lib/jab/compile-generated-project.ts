import "server-only";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createAdminClient } from "@/lib/supabase/admin";
import { SITE_SCREENSHOTS_BUCKET } from "@/lib/storage/bucket";
import { downloadProjectTree } from "@/lib/jab/download-project-tree";

/**
 * compileGeneratedProject — Phase C compile gate.
 *
 * Downloads the project tree from Storage into a temp directory, runs
 * `pnpm install` then `pnpm typecheck` (`tsc --noEmit`), and returns a
 * result object the caller uses to short-circuit Phase C before status
 * transitions to "building" and deploy dispatch.
 *
 * Why: Phase B's `validateTsx` only checks parse-level syntax. It misses
 * module-resolution errors, type mismatches, missing "use client" directives,
 * and component name contract violations. All of these are caught by a full
 * tsc run against the materialized project tree.
 *
 * Gate: controlled by `JAB_COMPOSE_TYPECHECK=1`. Install+tsc runs ~30–60s;
 * the gate is disabled by default so it can be enabled in smoke / operator
 * environments without affecting every production build.
 *
 * On failure: uploads `builds/<buildId>/compile-log.txt` to Storage and
 * updates `site_builds` with status="failed" / failed_phase="composing"
 * before returning `{ success: false }`. The Inngest step caller should
 * return early — the build is already marked failed so no further DB writes
 * are needed.
 *
 * Security: `spawn` with array args — never shell string interpolation.
 * `buildId` comes from an Inngest event payload and must not touch a shell.
 */
export interface CompileResult {
  success: boolean;
  log: string;
}

export async function compileGeneratedProject(opts: {
  buildId: string;
  projectId: string;
}): Promise<CompileResult> {
  // Gate: skip unless explicitly enabled.
  if (process.env.JAB_COMPOSE_TYPECHECK !== "1") {
    return { success: true, log: "typecheck skipped (JAB_COMPOSE_TYPECHECK not set)" };
  }

  const { buildId, projectId } = opts;
  let tmpDir: string | null = null;

  try {
    // 1. Download project tree from Storage.
    const files = await downloadProjectTree(buildId);

    // 2. Materialize into a temp directory.
    tmpDir = await mkdtemp(join(tmpdir(), "jab-compile-"));
    for (const [filePath, contents] of Object.entries(files)) {
      const fullPath = join(tmpDir, filePath);
      // Ensure parent directories exist (project has nested paths like app/page.tsx).
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, contents, "utf8");
    }

    // 3. Install dependencies. `--ignore-scripts` prevents any postinstall
    // scripts from running in the sandbox; `--frozen-lockfile=false` is
    // required because the materialized project has no lockfile.
    const installLog = await runCommand(
      "pnpm",
      ["install", "--ignore-scripts", "--frozen-lockfile=false"],
      tmpDir,
    );

    // 4. Typecheck.
    const typecheckLog = await runCommand("pnpm", ["typecheck"], tmpDir);

    const log = [installLog, typecheckLog].join("\n");
    return { success: true, log };
  } catch (err) {
    const log =
      err instanceof CompileError
        ? err.log
        : `Unexpected error: ${String(err)}`;

    // Upload compile log to Storage so the operator can inspect it.
    await uploadCompileLog(buildId, log).catch((uploadErr) => {
      console.error(
        "[compile-generated-project] failed to upload compile log:",
        uploadErr,
      );
    });

    // Mark the build failed in the DB.
    await updateBuildFailed(buildId, projectId, log).catch((dbErr) => {
      console.error(
        "[compile-generated-project] failed to update site_builds:",
        dbErr,
      );
    });

    return { success: false, log };
  } finally {
    // Always clean up the temp directory — even on success.
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Thrown when a spawned command exits with a non-zero code.
 * Carries the combined stdout+stderr as `log`.
 */
class CompileError extends Error {
  constructor(public log: string) {
    super("compile failed");
    this.name = "CompileError";
  }
}

/**
 * Spawn `cmd` with `args` in `cwd`. Resolves with the combined
 * stdout+stderr string on exit code 0. Rejects with `CompileError`
 * (carrying the same combined output) on any non-zero exit.
 *
 * Security: uses `spawn` with an args array — never passes the command
 * through a shell. `buildId` (embedded in `cwd`) never touches a shell.
 */
async function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "pipe" });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d));
    child.on("close", (code) => {
      const log = Buffer.concat(chunks).toString("utf8");
      if (code === 0) resolve(log);
      else reject(new CompileError(log));
    });
    child.on("error", (err) => reject(new CompileError(String(err))));
  });
}

/**
 * Upload `log` to `builds/<buildId>/compile-log.txt` in the artifact bucket.
 * Failures are non-fatal — the caller logs them and continues.
 */
async function uploadCompileLog(buildId: string, log: string): Promise<void> {
  const supabase = createAdminClient();
  const path = `builds/${buildId}/compile-log.txt`;
  const buf = Buffer.from(log, "utf8");
  const { error } = await supabase.storage
    .from(SITE_SCREENSHOTS_BUCKET)
    .upload(path, buf, { contentType: "text/plain", upsert: true });
  if (error) {
    throw new Error(`[compile-generated-project] upload compile-log failed: ${error.message}`);
  }
}

/**
 * Update the `site_builds` row to reflect a compile failure.
 * `error_text` is capped to 500 chars of the log to fit in a DB text column
 * without risk of giant payloads — the full log is in Storage.
 */
async function updateBuildFailed(
  buildId: string,
  projectId: string,
  log: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("site_builds")
    .update({
      status: "failed",
      failed_phase: "composing",
      error_text: `typecheck failed — see compile-log.txt (first 500 chars: ${log.slice(0, 500)})`,
    })
    .eq("id", buildId)
    .eq("project_id", projectId);
  if (error) {
    throw new Error(`[compile-generated-project] update site_builds failed: ${error.message}`);
  }
}
