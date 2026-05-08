import "server-only";
import { Resend } from "resend";

/**
 * Resend client for transactional email.
 *
 * v0 uses Resend for two purposes:
 *   1. Supabase Auth's built-in emails (sign-up confirm, password reset,
 *      magic links) — routed via Resend SMTP, configured in the Supabase
 *      dashboard. No code touches that path; Supabase handles it directly.
 *   2. App-level transactional email (Phase D+): notifying agencies when an
 *      AI generation job completes, sending invitation links once multi-user
 *      tenants ship, etc. THAT'S what this client is for.
 *
 * Same API key works for both purposes. Lazy-init so importing this module
 * at build time (where env vars may be unloaded) doesn't crash.
 */
let _client: Resend | null = null;

export function emailClient(): Resend {
  if (_client) return _client;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY not set. Generate at https://resend.com/api-keys and add to apps/web/.env.local",
    );
  }
  _client = new Resend(apiKey);
  return _client;
}

/**
 * Default sender. For dev: `onboarding@resend.dev` works without domain
 * verification but only sends to your own Resend account email. For prod:
 * verify a domain in Resend (Dashboard → Domains → Add → DNS) and set
 * RESEND_FROM_EMAIL to a sender on that domain.
 */
export function defaultFrom(): string {
  return process.env.RESEND_FROM_EMAIL ?? "Jab <onboarding@resend.dev>";
}
