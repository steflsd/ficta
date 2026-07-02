/**
 * Client-safe storage types. Imported by React components, route loaders, and the server store alike —
 * so it must pull in NO server code (no drizzle, no pg, no pglite). The shapes here are the contract of
 * the `Storage` seam (storage.server.ts); everything crossing the server-function boundary is one of
 * these plain, JSON-serializable objects, which is also what keeps a future Convex backend a drop-in.
 */

/** Per-user preferences. All fields optional; reads merge over code defaults so a fresh user is valid. */
export interface UserSettings {
  /** The model pre-selected in a new chat. Validated against MODELS on write; ignored on read if stale. */
  defaultModel?: { provider: string; model: string };
}

/** Instance-wide (admin-owned) settings. One row, shared by everyone on this deployment. */
export interface InstanceSettings {
  /** Shown in the header in place of "ficta". */
  instanceName?: string;
  /** Allow-list of `"provider/model"` keys. Undefined or empty = every model in MODELS is allowed. */
  allowedModels?: string[];
}

/** A thread as shown in a history list — no messages, cheap to list. */
export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A persisted chat message. `parts` is the TanStack AI `UIMessage.parts` array, stored opaque — we never
 * interpret it, just round-trip it through `initialMessages`. `id`/`role` are pulled out for indexing.
 */
export interface StoredMessage {
  id: string;
  role: "system" | "user" | "assistant";
  // Opaque UIMessage parts, round-tripped through jsonb. Typed `any[]` (not `unknown[]`) so the TanStack
  // server-fn boundary treats it as serializable — the shape is arbitrary but always JSON at runtime.
  parts: any[];
  createdAt?: string;
}

/** The stable key for a model choice, used by InstanceSettings.allowedModels and the ModelPicker filter. */
export function modelKey(m: { provider: string; model: string }): string {
  return `${m.provider}/${m.model}`;
}

/**
 * Whether a `"provider/model"` key is permitted by the instance allow-list. An undefined or empty list
 * means "no restriction" — every model is allowed. Used by the ModelPicker (filter) and api/chat.ts (403).
 */
export function isModelAllowed(instance: InstanceSettings, key: string): boolean {
  const allow = instance.allowedModels;
  return !allow || allow.length === 0 || allow.includes(key);
}
