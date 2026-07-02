/**
 * Applies the committed drizzle migrations at runtime, from SQL bundled INTO the server build.
 *
 * Why not drizzle's own migrator? Those read the `drizzle/` folder off the filesystem at runtime, which
 * a Nitro `.output` deploy can silently drop. `import.meta.glob(..., "?raw")` is a Vite compile-time macro
 * that inlines the `.sql` files (and the journal) as strings into the bundle, so migrations travel with
 * the code in dev, prod, and tests alike — and `drizzle-kit` never needs to connect to a database.
 *
 * The applier is driver-agnostic: it takes a tiny `SqlRunner` (implemented over PGlite or node-postgres in
 * client.server.ts, and over an in-memory PGlite in the tests) and does the classic "track applied tags in
 * a table, run the rest in journal order" dance. Each migration runs in its own transaction.
 */

// Vite inlines these at build time: keys are the glob-relative paths, values the raw file contents.
const SQL_FILES = import.meta.glob("../../../../drizzle/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const JOURNAL_RAW = import.meta.glob("../../../../drizzle/meta/_journal.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface JournalEntry {
  idx: number;
  tag: string;
}

/** The minimal database surface the applier needs; both PGlite and node-postgres satisfy it trivially. */
export interface SqlRunner {
  /** Run one or more `;`-separated statements (simple-query protocol / PGlite exec). */
  exec(sql: string): Promise<void>;
  /** Run a query and return its rows as plain objects. */
  rows(sql: string): Promise<Array<Record<string, unknown>>>;
}

/** tag → SQL body, keyed by the migration's filename stem (e.g. "0000_shiny_quentin_quire"). */
function sqlByTag(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [path, body] of Object.entries(SQL_FILES)) {
    const stem = path
      .split("/")
      .pop()
      ?.replace(/\.sql$/, "");
    if (stem) map.set(stem, body);
  }
  return map;
}

function journalEntries(): JournalEntry[] {
  const raw = Object.values(JOURNAL_RAW)[0];
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
  return (parsed.entries ?? []).slice().sort((a, b) => a.idx - b.idx);
}

/**
 * Bring the database up to date. Idempotent and safe to call on every boot: already-applied migrations are
 * skipped by tag. Concurrent callers should be serialized by the caller's memoized ready-promise, but the
 * per-tag check also makes a double-run harmless (a re-applied CREATE would error, so we never re-apply).
 */
export async function applyMigrations(db: SqlRunner): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ficta_migrations (tag text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const appliedRows = await db.rows(`SELECT tag FROM ficta_migrations`);
  const applied = new Set(appliedRows.map((r) => String(r.tag)));

  const bodies = sqlByTag();
  for (const entry of journalEntries()) {
    if (applied.has(entry.tag)) continue;
    const body = bodies.get(entry.tag);
    if (body === undefined) throw new Error(`migration "${entry.tag}" is in the journal but its .sql is missing`);
    // drizzle marks statement boundaries with this comment; strip it and run the file as one script.
    const statements = body.replaceAll("--> statement-breakpoint", "");
    await db.exec(`BEGIN;\n${statements}\nINSERT INTO ficta_migrations (tag) VALUES ('${entry.tag}');\nCOMMIT;`);
  }
}
