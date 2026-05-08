import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle config — schema introspection + migration scaffolding.
 *
 * The actual migrations are applied via the Supabase MCP (`apply_migration`)
 * which records them in `supabase_migrations.schema_migrations`. drizzle-kit
 * here is for: schema → SQL preview (`db:generate`), Drizzle Studio
 * (`db:studio`), and ad-hoc `db:push` for fast iteration during dev.
 *
 * Source-of-truth precedence: `lib/db/schema.ts` defines the shape; the SQL
 * files under `./drizzle/migrations/` are the committed history that landed
 * on the live database via the MCP.
 */
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  schemaFilter: ["public"],
  strict: true,
  verbose: true,
});
