import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Service-role Drizzle client. Bypasses RLS — use ONLY for system operations
 * that legitimately need to act outside any tenant scope (cron jobs, admin
 * tooling, the future onboarding flow when storing encrypted credentials).
 *
 * Phase B doesn't use this at runtime; included so Phase C can import it
 * without restructuring. End-user reads/writes in Phase B go through the
 * Supabase JS client (which respects RLS via the user's session JWT).
 *
 * Never log queries from this client without redaction — it can see every
 * tenant's data.
 */
const connectionString = process.env.DATABASE_URL;

// Lazy: only construct the connection when first used. Avoids errors during
// build-time imports when env vars aren't loaded.
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

export function dbAdmin() {
  if (_db) return _db;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  // prepare:false because Supabase's transaction-mode pooler doesn't support
  // prepared statements (statement names get reused across pooled connections).
  _client = postgres(connectionString, { prepare: false });
  _db = drizzle(_client, { schema });
  return _db;
}
