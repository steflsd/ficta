import type { InstanceSettings, StoredMessage, ThreadSummary, UserSettings } from "./types";

/**
 * The persistence boundary seam. Everything that reads or writes durable state in apps/web — settings and
 * chat history — goes through a `Storage`, so the backend (Drizzle over PGlite/Postgres today, possibly
 * Convex later) lives behind this interface and no route or component imports a database driver directly.
 * It mirrors the auth `AuthProvider` seam (provider.server.ts): interface + a memoized `getStorage()`
 * resolver whose dynamic import keeps drizzle/pg/pglite out of the client bundle and out of any code path
 * that never touches storage.
 *
 * The methods are deliberately Convex-portable: all async, all params/returns plain JSON-serializable, and
 * the scope keys (`userId`, `orgId`) are always passed in (never read from ambient request state inside the
 * store). Adding Convex later is one branch here plus one implementation file — exactly like the auth seam.
 *
 * Scoping: `userId` owns per-user rows; `orgId` is the workspace (tenant) threads and instance settings are
 * partitioned by. User settings are personal and follow the user across workspaces, so they take only `userId`.
 *
 * Server-only: imported from server functions (settings.ts, threads.ts) and api/chat.ts, never a component.
 */
export interface Storage {
  getUserSettings(userId: string): Promise<UserSettings>;
  patchUserSettings(userId: string, patch: Partial<UserSettings>): Promise<UserSettings>;

  getInstanceSettings(orgId: string): Promise<InstanceSettings>;
  patchInstanceSettings(orgId: string, patch: Partial<InstanceSettings>): Promise<InstanceSettings>;

  listThreads(userId: string, orgId: string): Promise<ThreadSummary[]>;
  getThread(
    userId: string,
    orgId: string,
    threadId: string,
  ): Promise<{ thread: ThreadSummary; messages: StoredMessage[] } | null>;
  /** Creates the thread if missing (title from the first user message), then snapshot-upserts messages. */
  saveThreadSnapshot(userId: string, orgId: string, threadId: string, messages: StoredMessage[]): Promise<void>;
  renameThread(userId: string, orgId: string, threadId: string, title: string): Promise<void>;
  deleteThread(userId: string, orgId: string, threadId: string): Promise<void>;
}

let cached: Promise<Storage> | null = null;

/**
 * Resolve the storage backend once per process. Single backend today (Drizzle, with its own PGlite|Postgres
 * driver switch inside); when a second backend exists this grows an env-var branch exactly like
 * getActiveProvider(). The dynamic import already pays off now — it keeps the DB drivers out of every bundle
 * and code path that doesn't touch storage.
 */
export function getStorage(): Promise<Storage> {
  if (!cached) cached = import("./drizzle/store.server").then((m) => m.createStorage());
  return cached;
}
