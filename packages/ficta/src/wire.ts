/**
 * Provider wire-format identity, derived from the request path. Kept side-effect-free so the
 * restore hot path (engine/vault/wire-restore) can depend on it without dragging in log.ts's
 * import-time setup.
 */

export type Wire = "anthropic" | "openai-chat" | "openai-responses" | "unknown";

export function wireOf(path: string): Wire {
  if (path.includes("/chat/completions")) return "openai-chat";
  if (path.includes("/responses")) return "openai-responses";
  if (path.includes("/messages")) return "anthropic";
  return "unknown";
}
