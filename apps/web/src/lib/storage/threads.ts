import { createServerFn } from "@tanstack/react-start";
import { requireScope } from "@/lib/auth/guards.server";
import { getStorage } from "./storage.server";
import type { StoredMessage, ThreadSummary } from "./types";

/**
 * Server functions for chat history. Like settings.ts, each re-derives the caller's scope (userId + the
 * active workspace orgId) via the guard, so a client can only read/write its own threads within its current
 * workspace (the store also enforces ownership). Messages are stored opaque — `parts` is validated to be an
 * array but not interpreted. Titles are derived in the store from the first user message.
 */

const ROLES = new Set(["system", "user", "assistant"]);

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null) throw new Error("invalid payload");
  return input as Record<string, unknown>;
}

function requireThreadId(input: unknown): { threadId: string } {
  const i = asObject(input);
  if (typeof i.threadId !== "string" || !i.threadId) throw new Error("invalid threadId");
  return { threadId: i.threadId };
}

function toStoredMessage(input: unknown): StoredMessage {
  const o = asObject(input);
  if (typeof o.id !== "string" || typeof o.role !== "string" || !ROLES.has(o.role) || !Array.isArray(o.parts)) {
    throw new Error("invalid message");
  }
  return {
    id: o.id,
    role: o.role as StoredMessage["role"],
    parts: o.parts,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : undefined,
  };
}

function validateStart(input: unknown): { threadId: string; message: StoredMessage } {
  const i = asObject(input);
  if (typeof i.threadId !== "string" || !i.threadId) throw new Error("invalid threadId");
  return { threadId: i.threadId, message: toStoredMessage(i.message) };
}

function validateSnapshot(input: unknown): { threadId: string; messages: StoredMessage[] } {
  const i = asObject(input);
  if (typeof i.threadId !== "string" || !i.threadId) throw new Error("invalid threadId");
  if (!Array.isArray(i.messages)) throw new Error("invalid messages");
  return { threadId: i.threadId, messages: i.messages.map(toStoredMessage) };
}

function validateRename(input: unknown): { threadId: string; title: string } {
  const i = asObject(input);
  if (typeof i.threadId !== "string" || !i.threadId) throw new Error("invalid threadId");
  if (typeof i.title !== "string") throw new Error("invalid title");
  return { threadId: i.threadId, title: i.title };
}

export const fetchThreads = createServerFn({ method: "GET" }).handler(async (): Promise<ThreadSummary[]> => {
  const { userId, orgId } = await requireScope();
  return (await getStorage()).listThreads(userId, orgId);
});

export const fetchThread = createServerFn({ method: "GET" })
  .validator(requireThreadId)
  .handler(async ({ data }): Promise<{ thread: ThreadSummary; messages: StoredMessage[] } | null> => {
    const { userId, orgId } = await requireScope();
    return (await getStorage()).getThread(userId, orgId, data.threadId);
  });

export const startThread = createServerFn({ method: "POST" })
  .validator(validateStart)
  .handler(async ({ data }): Promise<void> => {
    const { userId, orgId } = await requireScope();
    await (await getStorage()).startThread(userId, orgId, data.threadId, data.message);
  });

export const saveThread = createServerFn({ method: "POST" })
  .validator(validateSnapshot)
  .handler(async ({ data }): Promise<void> => {
    const { userId, orgId } = await requireScope();
    await (await getStorage()).saveThreadSnapshot(userId, orgId, data.threadId, data.messages);
  });

export const renameThread = createServerFn({ method: "POST" })
  .validator(validateRename)
  .handler(async ({ data }): Promise<void> => {
    const { userId, orgId } = await requireScope();
    await (await getStorage()).renameThread(userId, orgId, data.threadId, data.title);
  });

export const deleteThread = createServerFn({ method: "POST" })
  .validator(requireThreadId)
  .handler(async ({ data }): Promise<void> => {
    const { userId, orgId } = await requireScope();
    await (await getStorage()).deleteThread(userId, orgId, data.threadId);
  });
