/**
 * Minimal interactive-input helpers for the scaffold command. No new deps —
 * uses Node's built-in `node:readline` and raw-mode stdin manipulation.
 *
 * `prompt()` is for ordinary visible input (URLs, usernames).
 * `promptPassword()` masks input with `*` characters by switching stdin
 * into raw mode and intercepting keystrokes. Pasted input emits multiple
 * chars in one buffer; we iterate the whole buffer per chunk.
 *
 * Both helpers throw if stdin isn't a TTY — the caller is expected to
 * validate that before prompting, so the failure is surfaced as a clear
 * "missing required value" rather than a hang.
 */

import * as readline from "node:readline";

// Constants built via fromCharCode to avoid embedding raw control bytes
// in source. ETX = Ctrl+C, DEL/BS = backspace. Defined as char codes so
// every editor/lint pipeline sees them as plain ASCII numerics.
const KEY_ETX = String.fromCharCode(0x03);
const KEY_BACKSPACE_DEL = String.fromCharCode(0x7f);
const KEY_BACKSPACE_BS = String.fromCharCode(0x08);

export async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Cannot prompt: stdin is not a TTY (running non-interactively?).");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

/**
 * Read a line of input from stdin without echoing it to the terminal —
 * a `*` is printed for each character so the user can see the field is
 * accepting input. Handles paste (multi-char buffers), backspace,
 * Ctrl+C (exits with 130), and Enter (resolves).
 */
export async function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Cannot prompt for password: stdin is not a TTY.");
  }

  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let password = "";

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };

    const onData = (buf: Buffer) => {
      const str = buf.toString("utf8");
      for (const ch of str) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(password);
          return;
        }
        if (ch === KEY_ETX) {
          // Restore terminal then exit with the conventional SIGINT
          // exit code so callers can detect cancellation cleanly.
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === KEY_BACKSPACE_DEL || ch === KEY_BACKSPACE_BS) {
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        password += ch;
        process.stdout.write("*");
      }
    };

    process.stdin.on("data", onData);
  });
}
