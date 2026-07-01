/**
 * Any model / bring-your-own-key. The selected provider+model is forwarded to /api/chat, which builds
 * the matching TanStack AI adapter — every call still flows through the ficta proxy (see api/chat.ts).
 * Add entries here; nothing else needs to change.
 */
export const MODELS = [
  { provider: "openai", model: "gpt-5-mini", label: "OpenAI", sublabel: "gpt-5-mini" },
  { provider: "openai", model: "gpt-5", label: "OpenAI", sublabel: "gpt-5" },
  { provider: "openai", model: "gpt-5-nano", label: "OpenAI", sublabel: "gpt-5-nano" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Anthropic", sublabel: "claude-sonnet-4-6" },
] as const;

export type ModelChoice = (typeof MODELS)[number];
