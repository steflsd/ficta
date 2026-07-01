import { anthropicText } from "@tanstack/ai-anthropic";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";

export type Provider = "openai" | "anthropic";

export interface ModelChoice {
  provider: Provider;
  model: string;
}

/**
 * The provider seam. `FICTA_PROXY_URL` points each adapter's `baseURL` at the ficta redaction proxy,
 * so PII / secrets are tokenized before the vendor and restored on the way back. The firm's real API
 * keys stay server-side (never sent to the browser). Swap provider / model / key here — nowhere else.
 */
const FICTA_PROXY_URL = process.env.FICTA_PROXY_URL ?? "http://127.0.0.1:8787";

export function createModelAdapter({ provider, model }: ModelChoice) {
  if (provider === "anthropic") {
    // ficta routes `/v1/messages` → the Anthropic upstream; the Anthropic adapter emits that wire.
    // The adapter's model param is a known-Claude-id union; the UI supplies a validated id, so cast.
    return anthropicText(model as Parameters<typeof anthropicText>[0], {
      baseURL: FICTA_PROXY_URL,
      apiKey: requireKey("ANTHROPIC_API_KEY"),
    });
  }
  // ficta routes `/v1/chat/completions` → the OpenAI upstream; the OpenAI-compatible adapter emits it.
  return openaiCompatibleText(model, {
    baseURL: `${FICTA_PROXY_URL}/v1`,
    apiKey: requireKey("OPENAI_API_KEY"),
  });
}

function requireKey(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set server-side; required to reach the model via ficta`);
  return value;
}
