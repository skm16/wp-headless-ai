/**
 * Thin promise-returning wrapper around `child_process.spawn` for the
 * scaffold command's create-next-app invocation.
 *
 * Defaults to inherited stdio so the child's prompts and progress output
 * stream straight to the user's terminal — there's no point in piping
 * `npx create-next-app`'s output through a buffer; the user wants to see
 * it live as the install runs.
 *
 * On Windows, `npx` is a `.cmd` shim, which `spawn` won't execute without
 * the shell. We opt into `shell: true` only on win32; on POSIX it stays
 * off because shell usage with stringly-typed args invites injection. All
 * args we pass come from the CLI command parser and are validated upstream,
 * so the win32 shell-true is safe in this scope.
 */

import { spawn, type SpawnOptions } from "node:child_process";

export interface SpawnAndWaitOptions extends SpawnOptions {
  /** Override stdio inheritance — useful only in tests. */
  inheritStdio?: boolean;
}

export async function spawnAndWait(
  command: string,
  args: string[],
  opts: SpawnAndWaitOptions = {},
): Promise<void> {
  const isWindows = process.platform === "win32";
  const { inheritStdio = true, ...spawnOpts } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: inheritStdio ? "inherit" : "pipe",
      shell: isWindows,
      ...spawnOpts,
    });

    child.on("error", (err) => {
      reject(
        new Error(
          `Failed to spawn ${command}: ${err.message}. Is it installed and on PATH?`,
        ),
      );
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${command} ${args.join(" ")} failed (${reason}).`));
    });
  });
}
