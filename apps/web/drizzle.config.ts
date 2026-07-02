import { defineConfig } from "drizzle-kit";

/**
 * Config for `pnpm db:generate` (drizzle-kit generate) ONLY. `generate` reads the schema TS and emits
 * SQL into ./drizzle — it never opens a connection, so no `dbCredentials` and no driver are declared.
 * We deliberately do NOT script `push`/`studio`: those would connect, and studio against the local PGlite
 * data dir would collide with a running dev server holding the same dir. Migrations are applied at runtime
 * from the committed SQL — see src/lib/storage/drizzle/migrate.server.ts.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/storage/drizzle/schema.ts",
  out: "./drizzle",
});
