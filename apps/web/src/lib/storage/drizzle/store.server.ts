import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Storage } from "../storage.server";
import type { InstanceSettings, StoredMessage, ThreadSummary, UserSettings } from "../types";
import { getDb } from "./client.server";
import { instanceSettings, messages, threads, userSettings } from "./schema";

const TITLE_MAX = 80;

/**
 * The Drizzle-backed `Storage` implementation. Speaks the schema in schema.ts; the actual driver (PGlite
 * or node-postgres) is chosen inside getDb(). Nothing here is driver-specific — the same code runs against
 * both. Every method takes its scope keys (`userId`, `orgId`) explicitly and never reads ambient request
 * state, keeping the store a pure repository (and Convex-portable).
 */
export function createStorage(): Storage {
  return {
    async getUserSettings(userId) {
      const db = await getDb();
      const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
      return row?.data ?? {};
    },

    async patchUserSettings(userId, patch) {
      const db = await getDb();
      const current = await this.getUserSettings(userId);
      const next: UserSettings = { ...current, ...patch };
      await db
        .insert(userSettings)
        .values({ userId, data: next })
        .onConflictDoUpdate({ target: userSettings.userId, set: { data: next, updatedAt: new Date() } });
      return next;
    },

    async getInstanceSettings(orgId) {
      const db = await getDb();
      const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, orgId));
      return row?.data ?? {};
    },

    async patchInstanceSettings(orgId, patch) {
      const db = await getDb();
      const current = await this.getInstanceSettings(orgId);
      const next: InstanceSettings = { ...current, ...patch };
      await db
        .insert(instanceSettings)
        .values({ id: orgId, data: next })
        .onConflictDoUpdate({ target: instanceSettings.id, set: { data: next, updatedAt: new Date() } });
      return next;
    },

    async listThreads(userId, orgId) {
      const db = await getDb();
      const rows = await db
        .select()
        .from(threads)
        .where(and(eq(threads.userId, userId), eq(threads.orgId, orgId)))
        .orderBy(desc(threads.updatedAt));
      return rows.map(toThreadSummary);
    },

    async getThread(userId, orgId, threadId) {
      const db = await getDb();
      const [thread] = await db
        .select()
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.orgId, orgId)));
      if (!thread) return null;
      const rows = await db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(messages.orderIdx);
      return {
        thread: toThreadSummary(thread),
        messages: rows.map(
          (r): StoredMessage => ({
            id: r.id,
            role: r.role as StoredMessage["role"],
            parts: r.parts as StoredMessage["parts"],
            createdAt: r.createdAt.toISOString(),
          }),
        ),
      };
    },

    async startThread(userId, orgId, threadId, message) {
      const db = await getDb();
      await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(threads).where(eq(threads.id, threadId));
        if (existing) {
          // A thread id is client-generated; refuse to write into someone else's thread or workspace.
          if (existing.userId !== userId || existing.orgId !== orgId) throw new Error("thread not found");
          await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
        } else {
          await tx.insert(threads).values({ id: threadId, userId, orgId, title: deriveTitle([message]) });
        }

        await tx
          .insert(messages)
          .values({ id: message.id, threadId, role: message.role, parts: message.parts, orderIdx: 0 })
          .onConflictDoUpdate({
            target: messages.id,
            set: { parts: message.parts, orderIdx: 0, role: message.role },
          });
      });
    },

    async saveThreadSnapshot(userId, orgId, threadId, snapshot) {
      const db = await getDb();
      await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(threads).where(eq(threads.id, threadId));
        if (existing) {
          // A thread id is client-generated; refuse to write into someone else's thread or workspace.
          if (existing.userId !== userId || existing.orgId !== orgId) throw new Error("thread not found");
          await tx.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
        } else {
          await tx.insert(threads).values({ id: threadId, userId, orgId, title: deriveTitle(snapshot) });
        }

        // Snapshot semantics: the incoming list is the whole truth. Drop rows it no longer contains
        // (covers a client-side regenerate that replaces the trailing assistant message), upsert the rest.
        const ids = snapshot.map((m) => m.id);
        await tx
          .delete(messages)
          .where(
            ids.length
              ? and(eq(messages.threadId, threadId), notInArray(messages.id, ids))
              : eq(messages.threadId, threadId),
          );

        for (const [orderIdx, m] of snapshot.entries()) {
          await tx
            .insert(messages)
            .values({ id: m.id, threadId, role: m.role, parts: m.parts, orderIdx })
            .onConflictDoUpdate({
              target: messages.id,
              set: { parts: m.parts, orderIdx, role: m.role },
            });
        }
      });
    },

    async renameThread(userId, orgId, threadId, title) {
      const db = await getDb();
      await db
        .update(threads)
        .set({ title: title.slice(0, TITLE_MAX) || "New chat", updatedAt: new Date() })
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.orgId, orgId)));
    },

    async deleteThread(userId, orgId, threadId) {
      const db = await getDb();
      // messages cascade via the FK.
      await db
        .delete(threads)
        .where(and(eq(threads.id, threadId), eq(threads.userId, userId), eq(threads.orgId, orgId)));
    },
  };
}

function toThreadSummary(row: { id: string; title: string; createdAt: Date; updatedAt: Date }): ThreadSummary {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** First user message's text, trimmed to a title. Falls back to the default when there's nothing to show. */
function deriveTitle(snapshot: StoredMessage[]): string {
  const firstUser = snapshot.find((m) => m.role === "user");
  const text = firstUser ? partsToText(firstUser.parts) : "";
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  return trimmed || "New chat";
}

/** Pull plain text out of the opaque UIMessage parts, ignoring other part types. The live SDK's text part
 * is `{ type: "text", content }`; `text` is accepted as a fallback for any older/hand-built shape. */
function partsToText(parts: unknown[]): string {
  return parts
    .map((p) => {
      if (!p || typeof p !== "object" || (p as { type?: unknown }).type !== "text") return "";
      const part = p as { content?: unknown; text?: unknown };
      return String(part.content ?? part.text ?? "");
    })
    .join("");
}
