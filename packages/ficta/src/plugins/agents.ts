import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentIntegration, AgentIntegrationPlugin } from "./types.js";

export const claudeAgent: AgentIntegration = {
  id: "builtin/claude",
  command: "claude",
  label: "Claude Code",
  description: "Uses ANTHROPIC_BASE_URL to route Claude Messages API traffic through ficta",
  shouldBypass: commonNonModelCommand,
  configureLaunch: ({ baseUrl, args, realExecutable, env }) => ({
    executable: realExecutable,
    args,
    env: { ...env, ANTHROPIC_BASE_URL: baseUrl },
  }),
};

export const codexAgent: AgentIntegration = {
  id: "builtin/codex",
  command: "codex",
  label: "OpenAI Codex CLI",
  description: "Injects a temporary custom provider config for OpenAI/Codex traffic",
  shouldBypass: commonNonModelCommand,
  configureLaunch: ({ baseUrl, args, realExecutable, env }) => {
    const overrides = [
      `model_provider="ficta"`,
      `model_providers.ficta.name="ficta"`,
      `model_providers.ficta.base_url="${baseUrl}/v1"`,
    ];
    if (codexUsesChatgptAuth(env)) {
      overrides.push("model_providers.ficta.requires_openai_auth=true");
      overrides.push(`chatgpt_base_url="${baseUrl}/backend-api/"`);
    }
    return {
      executable: realExecutable,
      args: [...overrides.flatMap((o) => ["-c", o]), ...args],
      env,
    };
  },
  configureBypass: ({ args, realExecutable, env }) => {
    const cleanup = codexPersistedFictaCleanupOverrides(env);
    return {
      executable: realExecutable,
      args: [...cleanup.flatMap((o) => ["-c", o]), ...args],
      env,
    };
  },
};

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export const piAgent: AgentIntegration = {
  id: "builtin/pi",
  command: "pi",
  label: "Pi coding agent",
  description:
    "Routes Pi's built-in providers through ficta via an ephemeral PI_CODING_AGENT_DIR with a models.json base-URL override",
  shouldBypass: (args) => commonNonModelCommand(args) || PI_NON_MODEL_COMMANDS.has(args[0] ?? ""),
  configureLaunch: ({ baseUrl, args, realExecutable, env }) => {
    // Pi ignores an extension's registerProvider({ baseUrl }) override for routing
    // (it patches model copies post-load and the override never reaches the request
    // layer). The reliable override is a models.json provider baseUrl, applied at
    // startup before model selection. So we point Pi at a throwaway agent dir that
    // mirrors the user's real auth/settings but swaps in a ficta-routed models.json.
    const sourceDir = piSourceAgentDir(env);
    const dir = mkdtempSync(join(tmpdir(), "ficta-pi-"));
    const sourceModels = mirrorPiAgentDir(sourceDir, dir);
    writeFileSync(join(dir, "models.json"), piModelsConfig(baseUrl, sourceModels), { mode: 0o600 });
    return {
      executable: realExecutable,
      args,
      env: { ...env, [PI_AGENT_DIR_ENV]: dir },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
};

export const builtInAgentPlugin: AgentIntegrationPlugin = {
  kind: "agent-integration",
  name: "builtin-agent-integrations",
  description: "Launch adapters for supported coding agents",
  agents: [claudeAgent, codexAgent, piAgent],
};

const PI_NON_MODEL_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);

function commonNonModelCommand(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v");
}

export function codexUsesChatgptAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const home = codexHome(env);
    const data = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    if (typeof data.auth_mode === "string") return data.auth_mode.toLowerCase() === "chatgpt";
    return Boolean(data?.tokens?.account_id);
  } catch {
    return false;
  }
}

export function codexPersistedFictaCleanupOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  const text = readCodexConfig(env);
  if (!text || !codexConfigHasPersistedFictaRouting(text)) return [];

  if (codexUsesChatgptAuth(env)) {
    return [
      `model_provider="ficta_direct_chatgpt"`,
      `model_providers.ficta_direct_chatgpt.name="ChatGPT direct (ficta bypass)"`,
      `model_providers.ficta_direct_chatgpt.base_url="https://chatgpt.com/backend-api/codex"`,
      "model_providers.ficta_direct_chatgpt.requires_openai_auth=true",
      `chatgpt_base_url="https://chatgpt.com/backend-api/"`,
    ];
  }

  const overrides: string[] = [];
  if (/^\s*model_provider\s*=\s*["']ficta["']/m.test(text)) overrides.push(`model_provider="openai"`);
  if (/^\s*openai_base_url\s*=\s*["']https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/v1\/?["']/m.test(text)) {
    overrides.push(`openai_base_url="https://api.openai.com/v1"`);
  }
  if (/^\s*chatgpt_base_url\s*=\s*["']https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/backend-api\/?["']/m.test(text)) {
    overrides.push(`chatgpt_base_url="https://chatgpt.com/backend-api/"`);
  }
  return overrides;
}

function codexConfigHasPersistedFictaRouting(text: string): boolean {
  return (
    /^\s*model_provider\s*=\s*["']ficta["']/m.test(text) ||
    /^\s*openai_base_url\s*=\s*["']https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/v1\/?["']/m.test(text) ||
    /^\s*chatgpt_base_url\s*=\s*["']https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/backend-api\/?["']/m.test(text) ||
    /^\s*base_url\s*=\s*["']https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/v1\/?["']/m.test(text)
  );
}

function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? join(homedir(), ".codex");
}

function readCodexConfig(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return readFileSync(join(codexHome(env), "config.toml"), "utf8");
  } catch {
    return undefined;
  }
}

/** Resolve the user's real Pi agent dir (honoring an existing PI_CODING_AGENT_DIR). */
function piSourceAgentDir(env: NodeJS.ProcessEnv): string {
  const override = env[PI_AGENT_DIR_ENV];
  if (override) return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
  return join(homedir(), ".pi", "agent");
}

/**
 * Symlink every entry of the user's agent dir into `dest` except `models.json`
 * (which ficta regenerates), so Pi keeps its real auth/settings/trust/sessions.
 * Returns the source models.json contents if present, for merging.
 */
function mirrorPiAgentDir(sourceDir: string, dest: string): string | undefined {
  if (!existsSync(sourceDir)) return undefined;
  let sourceModels: string | undefined;
  for (const name of readdirSync(sourceDir)) {
    if (name === "models.json") {
      try {
        sourceModels = readFileSync(join(sourceDir, name), "utf8");
      } catch {
        // Unreadable; fall back to overrides-only.
      }
      continue;
    }
    try {
      symlinkSync(join(sourceDir, name), join(dest, name));
    } catch {
      // Best effort: skip entries we cannot link (e.g. already present).
    }
  }
  return sourceModels;
}

/**
 * Build a Pi `models.json` that overrides the base URLs of the built-in providers
 * ficta can route (`anthropic`, `openai`, `openai-codex`) to the local proxy, while
 * preserving any user-defined providers untouched. Custom providers point at their
 * own upstreams, which ficta cannot forward, so they are intentionally left as-is.
 */
export function piModelsConfig(baseUrl: string, sourceModels?: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  let top: Record<string, unknown> = {};
  let providers: Record<string, Record<string, unknown>> = {};
  if (sourceModels) {
    try {
      const parsed = JSON.parse(sourceModels) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        top = parsed;
        const p = parsed.providers;
        if (p && typeof p === "object") providers = { ...(p as Record<string, Record<string, unknown>>) };
      }
    } catch {
      // Malformed user models.json — start from overrides only.
    }
  }
  const override = (name: string, providerBase: string) => {
    providers[name] = { ...(providers[name] ?? {}), baseUrl: providerBase };
  };
  override("anthropic", base); // Pi appends /v1/messages
  override("openai", `${base}/v1`); // Pi appends /chat/completions or /responses
  override("openai-codex", `${base}/backend-api`); // ChatGPT/Codex backend
  return JSON.stringify({ ...top, providers }, null, 2);
}
