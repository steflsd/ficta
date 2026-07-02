import { mkdirSync } from "node:fs";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { applyMigrations, type SqlRunner } from "./migrate.server";
import * as schema from "./schema";

/**
 * Resolves the one database handle for this process and runs migrations before first use.
 *
 * Driver selection (D2): `DATABASE_URL` set → real Postgres via node-postgres Pool; unset → an embedded,
 * file-backed PGlite at `FICTA_WEB_DATA_DIR` (default `.data/pglite`). The zero-config PGlite default is
 * what keeps a self-hosted `AUTH_PROVIDER=none` install working with no external service.
 *
 * Two singletons guard correctness:
 *  - the handle lives on `globalThis` so Vite's SSR module invalidation (which re-imports this file on
 *    edits) reuses the one PGlite instance instead of opening the data dir twice (D10);
 *  - a memoized `ready` promise runs migrations exactly once and serializes concurrent first-touch — two
 *    requests racing at boot await the same migration.
 *
 * Multi-process deployments must set `DATABASE_URL`: PGlite is single-connection, one instance per dir.
 */

export type Database =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzleNodePg<typeof schema>>;

interface Handle {
  db: Database;
  ready: Promise<void>;
}

// Stash on globalThis so HMR / SSR re-imports don't double-open. The symbol keeps it off the typed global.
const KEY = Symbol.for("ficta.web.db");
type GlobalWithDb = typeof globalThis & { [KEY]?: Handle };

function create(): Handle {
  const url = process.env.DATABASE_URL;
  if (url) {
    const db = drizzleNodePg({ connection: url, schema });
    const runner: SqlRunner = {
      exec: async (sql) => {
        // node-postgres uses the simple-query protocol when there are no params, allowing multi-statement.
        await db.$client.query(sql);
      },
      rows: async (sql) => (await db.$client.query(sql)).rows,
    };
    return { db, ready: applyMigrations(runner) };
  }

  const dataDir = process.env.FICTA_WEB_DATA_DIR ?? ".data/pglite";
  // PGlite's own mkdir isn't recursive, so a fresh `.data/pglite` (missing parent) throws ENOENT.
  // Pre-create the tree for real filesystem paths; skip URL-scheme dirs like `memory://` / `idb://`.
  if (!dataDir.includes("://")) mkdirSync(dataDir, { recursive: true });
  const db = drizzlePglite(dataDir, { schema });
  const runner: SqlRunner = {
    exec: async (sql) => {
      await db.$client.exec(sql);
    },
    rows: async (sql) => (await db.$client.query(sql)).rows as Array<Record<string, unknown>>,
  };
  return { db, ready: applyMigrations(runner) };
}

/** The migrated database handle. Awaits migrations on first call, then hands back the shared instance. */
export async function getDb(): Promise<Database> {
  const g = globalThis as GlobalWithDb;
  let handle = g[KEY];
  if (!handle) {
    handle = create();
    g[KEY] = handle;
  }
  await handle.ready;
  return handle.db;
}
