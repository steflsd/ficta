import type { UIMessage } from "@tanstack/ai-react";
import type { StoredMessage } from "./types";

/**
 * Convert between the chat client's `UIMessage` and the persisted `StoredMessage`. The only real
 * difference is `createdAt` (Date on the wire-live message, ISO string at rest) and that `parts` is stored
 * opaque — we round-trip it without interpreting it. Client-safe; shared by ChatView (save) and the thread
 * route loader (hydrate).
 */

export function uiToStored(m: UIMessage): StoredMessage {
  return {
    id: m.id,
    role: m.role,
    parts: m.parts,
    createdAt: m.createdAt?.toISOString(),
  };
}

export function storedToUi(m: StoredMessage): UIMessage {
  return {
    id: m.id,
    role: m.role,
    parts: m.parts as UIMessage["parts"],
    createdAt: m.createdAt ? new Date(m.createdAt) : undefined,
  };
}
