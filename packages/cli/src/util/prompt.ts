/**
 * Minimal interactive-input helpers for the scaffold and init commands.
 * No new deps — uses Node's built-in `node:readline`, `node:fs`, and
 * raw-mode stdin manipulation.
 *
 * `prompt()` is for ordinary visible input (URLs, usernames).
 * `promptPassword()` masks input with `*` characters by switching stdin
 * into raw mode and intercepting keystrokes. Pasted input emits multiple
 * chars in one buffer; we iterate the whole buffer per chunk.
 *
 * Git Bash / MinTTY compatibility: Node sees `process.stdin` on MinTTY
 * as a pipe, not a TTY (a long-standing Node-on-Windows quirk), so a
 * naive `if (!isTTY) error` would refuse to prompt in the most common
 * Windows dev terminal. We fall back to `/dev/tty` which Git Bash does
 * expose. The fallback path can't `setRawMode`, so masked input
 * degrades to visible input with a one-line warning — better than
 * refusing to run.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";

// Constants built via fromCharCode to avoid embedding raw control bytes
// in source. ETX = Ctrl+C, DEL/BS = backspace.
const KEY_ETX = String.fromCharCode(0x03);
const KEY_BACKSPACE_DEL = String.fromCharCode(0x7f);
const KEY_BACKSPACE_BS = String.fromCharCode(0x08);

interface InputContext {
  stream: NodeJS.ReadableStream;
  /** True when the stream IS process.stdin and is a real TTY (supports setRawMode). */
  isInteractiveTty: boolean;
  /** Cleanup hook — close fallback streams etc. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Pick the best available input stream:
 *   - process.stdin if it's a TTY (POSIX terminals, Windows cmd/PowerShell)
 *   - /dev/tty as a fallback (Git Bash / MinTTY, WSL, anywhere stdin is a pipe
 *     but the controlling terminal is still reachable)
 * Returns null when neither path works (CI / piped stdin / no TTY at all).
 */
function openInput(): InputContext | null {
  if (process.stdin.isTTY) {
    return {
      stream: process.stdin,
      isInteractiveTty: true,
      cleanup: () => {},
    };
  }
  try {
    const fd = fs.openSync("/dev/tty", "r");
    const stream = fs.createReadStream("", { fd, autoClose: false });
    let closed = false;
    return {
      stream,
      isInteractiveTty: false,
      cleanup: () => {
        if (closed) return;
        closed = true;
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}

export async function prompt(question: string): Promise<string> {
  const ctx = openInput();
  if (!ctx) {
    throw new Error(
      "Cannot prompt: no interactive terminal available (running non-interactively?). Pass the value as a CLI flag.",
    );
  }
  const rl = readline.createInterface({
    input: ctx.stream,
    output: process.stdout,
  });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
    ctx.cleanup();
  }
}

/**
 * Read a line of input from the controlling terminal without echoing it
 * (when possible). Falls back to visible input with a warning when the
 * underlying input stream doesn't support raw mode (Git Bash / MinTTY).
 *
 * Handles paste (multi-char buffers), backspace, Ctrl+C (exits with 130),
 * and Enter (resolves). Visible-fallback delegates to readline since
 * masking isn't possible there anyway.
 */
export async function promptPassword(question: string): Promise<string> {
  const ctx = openInput();
  if (!ctx) {
    throw new Error(
      "Cannot prompt for password: no interactive terminal available. Pass --password, set WP_APP_PASSWORD, or run from a TTY.",
    );
  }

  if (!ctx.isInteractiveTty) {
    console.warn(
      "⚠ This terminal doesn't expose a TTY to Node, so password masking is unavailable. Input will be visible.",
    );
    console.warn(
      "  (Git Bash / MinTTY limitation — for masking either run via `winpty jab ...`, or set WP_APP_PASSWORD as an env var to skip the prompt.)",
    );
    const rl = readline.createInterface({
      input: ctx.stream,
      output: process.stdout,
    });
    try {
      return await new Promise<string>((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
      });
    } finally {
      rl.close();
      ctx.cleanup();
    }
  }

  // Real TTY — masked raw-mode prompt.
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let password = "";

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      ctx.cleanup();
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
