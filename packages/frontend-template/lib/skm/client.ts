/**
 * Server-side MCP client wired from environment variables.
 *
 * Imported by Server Components, route handlers, and server actions. The
 * env vars below are NEVER read in the browser — Next.js' default behavior
 * is to keep `process.env.X` server-only unless prefixed with NEXT_PUBLIC_,
 * which our credentials must never have.
 *
 * If you need a client-side fetch, build a route handler that calls this
 * server-side and proxy the result.
 */

import "server-only";
import { createClient } from "@/lib/sdk";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env.local and fill in your WP credentials.`,
    );
  }
  return value;
}

export const skmClient = createClient({
  wpUrl: required("WP_URL"),
  user: required("WP_USER"),
  password: required("WP_APP_PASSWORD"),
});
