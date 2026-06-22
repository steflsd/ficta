import { defaultLogDir } from "./defaults.js";
import { loadUserConfig } from "./user-config.js";

loadUserConfig();

export interface Config {
  port: number;
  upstreams: { anthropic: string; openai: string; chatgpt: string };
  forcedUpstream?: string;
  logDir: string;
  logBodies: boolean;
  quiet: boolean;
  failClosed: boolean;
  silent: boolean;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.FICTA_PORT ?? 8787),
    upstreams: {
      anthropic: process.env.FICTA_ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com",
      openai: process.env.FICTA_OPENAI_UPSTREAM ?? "https://api.openai.com",
      // Codex on ChatGPT/OAuth auth talks to the ChatGPT backend, not the API.
      chatgpt: process.env.FICTA_CHATGPT_UPSTREAM ?? "https://chatgpt.com",
    },
    // Override routing entirely (handy for testing).
    forcedUpstream: process.env.FICTA_UPSTREAM,
    logDir: process.env.FICTA_LOG_DIR ?? defaultLogDir(),
    // Logs contain REAL request/response bodies — opt in with FICTA_LOG_BODIES=1.
    logBodies: process.env.FICTA_LOG_BODIES === "1",
    // FICTA_QUIET=1 → console shows only model turns, not plugin/mcp/telemetry noise.
    quiet: process.env.FICTA_QUIET === "1",
    // Privacy boundary: refuse to forward if a registered value survived redaction. Default ON.
    // FICTA_FAIL_CLOSED=0 to fall back to forwarding (lab/debug only).
    failClosed: process.env.FICTA_FAIL_CLOSED !== "0",
    // FICTA_SILENT=1 → no proxy console output (the wrapper sets this so it never garbles the agent TUI).
    silent: process.env.FICTA_SILENT === "1",
  };
}

/**
 * Resolve the full upstream URL (host + possibly-rewritten path) for a request.
 *
 * Codex on ChatGPT/OAuth (detected by the `chatgpt-account-id` header) sends
 * OpenAI-style `/v1/responses` to its custom provider; the real endpoint is the
 * ChatGPT backend, so we rewrite the path — mirroring headroom's approach.
 */
export function resolveTarget(
  cfg: Config,
  pathname: string,
  search: string,
  headers: Headers,
): { url: string; note: string } {
  const t = (base: string, path: string, note: string) => ({ url: base + path + search, note });
  if (cfg.forcedUpstream) return t(cfg.forcedUpstream, pathname, "forced");

  const oauth = headers.has("chatgpt-account-id"); // Codex ChatGPT/OAuth

  // Already a ChatGPT-backend path (Codex housekeeping) → passthrough to chatgpt.
  if (pathname.includes("/backend-api")) return t(cfg.upstreams.chatgpt, pathname, "chatgpt");

  // Model inference: Codex's custom provider posts /v1/responses or /v1/codex/responses.
  if (pathname.endsWith("/responses")) {
    return oauth
      ? t(cfg.upstreams.chatgpt, "/backend-api/codex/responses", "chatgpt(responses↦backend)")
      : t(cfg.upstreams.openai, pathname, "openai");
  }
  // Model registry: public /v1/models 403s on OAuth → ChatGPT backend.
  if (pathname.endsWith("/models") || pathname.includes("/models/")) {
    return oauth
      ? t(cfg.upstreams.chatgpt, "/backend-api/codex/models", "chatgpt(models↦backend)")
      : t(cfg.upstreams.openai, pathname, "openai");
  }
  if (pathname.includes("/chat/completions") || pathname.includes("/completions"))
    return t(cfg.upstreams.openai, pathname, "openai");
  if (pathname.includes("/messages")) return t(cfg.upstreams.anthropic, pathname, "anthropic");
  return t(cfg.upstreams.anthropic, pathname, "anthropic(default)");
}
