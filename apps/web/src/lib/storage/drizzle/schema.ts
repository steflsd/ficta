import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { InstanceSettings, UserSettings } from "../types";

/**
 * Postgres schema for the storage seam. One dialect only: PGlite (the zero-config default) and real
 * Postgres (via DATABASE_URL) speak the same SQL, so this file drives both. `drizzle-kit generate` reads
 * ONLY this module to emit migration SQL — it never connects to a database (see migrate.server.ts for how
 * the generated SQL is applied). Keep this file free of server-only side effects for that reason.
 *
 * There is deliberately no `users` table: the auth provider's user id is an opaque scoping string
 * (`AuthUser.id`, or the "local" sentinel in `none` mode), matching the AuthUser Convex-key intent.
 * The same holds for the org (tenant) scope: `orgId` is an opaque string — a WorkOS `org_...` id, a
 * `user:<id>` personal-workspace fallback, or "local" in `none` mode. No `organizations` table.
 */

/** One row per user; `data` is the whole UserSettings object (see D4 — typed jsonb, not KV rows). */
export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  data: jsonb("data").$type<UserSettings>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per workspace, keyed by `orgId` (the scope key — "local", a WorkOS org id, or `user:<id>`).
 * Admin settings are per-org, so org-mates share an instance name and model allow-list. */
export const instanceSettings = pgTable("instance_settings", {
  id: text("id").primaryKey(),
  data: jsonb("data").$type<InstanceSettings>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A chat conversation. Id is client-generated (crypto.randomUUID) so a new chat has a stable id pre-save.
 * Scoped by both `userId` (private to its author) and `orgId` (the workspace it was created in). */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull().default("local"),
    title: text("title").notNull().default("New chat"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("threads_scope_updated_idx").on(t.userId, t.orgId, t.updatedAt.desc())],
);

/**
 * One row per message (not a blob per thread) to leave search/pagination open later. `parts` is the
 * opaque UIMessage parts array; `orderIdx` is the message's position within the snapshot so ordering
 * survives a reload without relying on timestamps.
 */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    parts: jsonb("parts").notNull(),
    orderIdx: integer("order_idx").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_thread_idx").on(t.threadId, t.orderIdx)],
);
