/**
 * Shared credential-resolution helpers used by both `init` and `scaffold`.
 *
 * The same three-tier lookup applies to both commands:
 *   1. Explicit CLI flag (with shell-history warning for passwords).
 *   2. Environment variable (passwords only — URL/user via env adds no
 *      meaningful security boundary).
 *   3. Interactive prompt — masked when the terminal supports raw mode,
 *      visible-with-warning on Git Bash / MinTTY (where Node can't see
 *      stdin as a TTY but /dev/tty is still reachable).
 *
 * The prompt helpers in ./prompt.ts handle TTY detection and the
 * /dev/tty fallback internally; this module just routes values through
 * the priority chain and surfaces clear errors when nothing's available.
 */

import { prompt, promptPassword } from "./prompt.js";

/**
 * Ensure a value is present. If missing and an interactive terminal is
 * available (real TTY or /dev/tty fallback), prompt the user. Otherwise
 * throw with a message that names the flag and the WP_APP_PASSWORD
 * fallback so users hit a clear error rather than a hang.
 */
export async function ensureValue(
  value: string | undefined,
  label: string,
): Promise<string> {
  if (value && value.trim() !== "") return value.trim();
  try {
    const answer = await prompt(`Enter ${label}: `);
    if (!answer) throw new Error(`${label} is required.`);
    return answer;
  } catch (err) {
    // Re-throw with a more useful action item than the underlying
    // "no interactive terminal" message.
    if (err instanceof Error && err.message.startsWith("Cannot prompt:")) {
      throw new Error(
        `Missing required value: ${label}. Pass the corresponding flag or run from an interactive terminal.`,
      );
    }
    throw err;
  }
}

/**
 * Resolve a WP Application Password from a --password flag, the
 * WP_APP_PASSWORD env var, or a (masked when possible) stdin prompt —
 * in that priority order. Warns when the password came from the flag
 * (it lands in shell history); warns when masking is unavailable.
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
  try {
    const value = await promptPassword(
      "Enter your WP Application Password (input hidden when supported): ",
    );
    if (!value) throw new Error("Password is required.");
    return value;
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith("Cannot prompt for password:")
    ) {
      throw new Error(
        "Missing password. Pass --password=<value>, set WP_APP_PASSWORD, or run from an interactive terminal.",
      );
    }
    throw err;
  }
}
