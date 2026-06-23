import { homedir } from "node:os";
import { join } from "node:path";
import { defaultLogDir } from "./defaults.js";
import { loadUserConfig } from "./user-config.js";

loadUserConfig();

export const DEFAULT_UPSTREAMS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  // Codex on ChatGPT/OAuth auth talks to the ChatGPT backend, not the API.
  chatgpt: "https://chatgpt.com",
} as const;

const DEFAULT_UPSTREAM_ORIGINS = new Set(Object.values(DEFAULT_UPSTREAMS).map((url) => new URL(url).origin));
const DEFAULT_LOG_MAX_BYTES = 256 * 1024;

export interface Config {
  port: number;
  upstreams: { anthropic: string; openai: string; chatgpt: string };
  forcedUpstream?: string;
  allowCustomUpstream: boolean;
  logDir: string;
  logBodies: boolean;
  logMaxBytes: number;
  quiet: boolean;
  failClosed: boolean;
  silent: boolean;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.FICTA_PORT ?? 8787),
    upstreams: {
      anthropic: process.env.FICTA_ANTHROPIC_UPSTREAM ?? DEFAULT_UPSTREAMS.anthropic,
      openai: process.env.FICTA_OPENAI_UPSTREAM ?? DEFAULT_UPSTREAMS.openai,
      chatgpt: process.env.FICTA_CHATGPT_UPSTREAM ?? DEFAULT_UPSTREAMS.chatgpt,
    },
    // Override routing entirely (handy for testing with loopback upstreams).
    forcedUpstream: process.env.FICTA_UPSTREAM,
    allowCustomUpstream: envFlag(process.env.FICTA_ALLOW_CUSTOM_UPSTREAM),
    logDir: expandHome(process.env.FICTA_LOG_DIR ?? defaultLogDir()),
    // Logs contain REAL request/response bodies — opt in with FICTA_LOG_BODIES=1.
    logBodies: process.env.FICTA_LOG_BODIES === "1",
    logMaxBytes: boundedInt(process.env.FICTA_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES, 1024, 16 * 1024 * 1024),
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

export function upstreamPolicyIssue(cfg: Config, target: string): string | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return `invalid upstream URL: ${target}`;
  }

  if (DEFAULT_UPSTREAM_ORIGINS.has(url.origin) || isLoopbackHost(url.hostname)) return undefined;
  if (!cfg.allowCustomUpstream) {
    return `custom upstream ${url.origin} requires FICTA_ALLOW_CUSTOM_UPSTREAM=1 before provider auth headers are forwarded`;
  }
  if (url.protocol !== "https:") return `non-loopback custom upstream ${url.origin} must use https`;
  return undefined;
}

export function configuredUpstreamPolicyIssues(cfg: Config): string[] {
  const bases = [cfg.forcedUpstream, cfg.upstreams.anthropic, cfg.upstreams.openai, cfg.upstreams.chatgpt].filter(
    (value): value is string => Boolean(value),
  );
  return [
    ...new Set(bases.map((base) => upstreamPolicyIssue(cfg, base)).filter((issue): issue is string => Boolean(issue))),
  ];
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function envFlag(value: string | undefined): boolean {
  const raw = value?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes" || raw === "enabled";
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}
