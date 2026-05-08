/**
 * Shared credential-resolution helpers used by both `init` and `scaffold`.
 *
 * The same three-tier lookup applies to both commands:
 *   1. Explicit CLI flag (with shell-history warning for passwords).
 *   2. Environment variable (passwords only — URL/user via env adds no
 *      meaningful security boundary).
 *   3. Interactive stdin prompt — masked for passwords, visible for
 *      everything else.
 *
 * Non-TTY contexts error fast instead of hanging. CI scripts that don't
 * pass flags get a clear "missing required value" error rather than a
 * silent wait.
 */

import { prompt, promptPassword } from "./prompt.js";

/**
 * Ensure a value is present. If missing and stdin is a TTY, prompt the user.
 * Otherwise throw — keeps non-interactive runs (CI, scripts) from hanging.
 */
export async function ensureValue(
  value: string | undefined,
  label: string,
): Promise<string> {
  if (value && value.trim() !== "") return value.trim();
  if (!process.stdin.isTTY) {
    throw new Error(
      `Missing required value: ${label}. Pass the corresponding flag or run interactively.`,
    );
  }
  const answer = await prompt(`Enter ${label}: `);
  if (!answer) throw new Error(`${label} is required.`);
  return answer;
}

/**
 * Resolve a WP Application Password from a --password flag, the
 * WP_APP_PASSWORD env var, or a masked stdin prompt — in that priority
 * order. Warns when the password came from the flag (since it lands in
 * shell history).
 */
export async function resolvePassword(
  passwordFlag: string | undefined,
): Promise<string> {
  if (passwordFlag && passwordFlag.trim() !== "") {
    console.warn(
      "⚠ Reading password from --password flag. It will be visible in your shell history.",
    );
    return passwordFlag;
  }
  const fromEnv = process.env.WP_APP_PASSWORD;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error(
      "Missing password. Pass --password=<value>, set WP_APP_PASSWORD, or run interactively.",
    );
  }
  const value = await promptPassword(
    "Enter your WP Application Password (input hidden): ",
  );
  if (!value) throw new Error("Password is required.");
  return value;
}
