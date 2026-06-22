import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentIntegration, FictaPlugin } from "./types.js";

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

export const piAgent: AgentIntegration = {
  id: "builtin/pi",
  command: "pi",
  label: "Pi coding agent",
  description: "Injects a temporary Pi extension that overrides supported provider base URLs",
  shouldBypass: (args) => commonNonModelCommand(args) || PI_NON_MODEL_COMMANDS.has(args[0] ?? ""),
  configureLaunch: ({ baseUrl, args, realExecutable, env }) => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-pi-"));
    const extensionPath = join(dir, "ficta-provider.ts");
    writeFileSync(extensionPath, piProviderExtension(), { mode: 0o600 });
    return {
      executable: realExecutable,
      args: ["-e", extensionPath, ...args],
      env: { ...env, FICTA_BASE_URL: baseUrl },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
};

export const builtInAgentPlugin: FictaPlugin = {
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

export function piProviderExtension(): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const base = process.env.FICTA_BASE_URL?.replace(/\\/+$/, "");
  if (!base) return;
  const v1 = base + "/v1";

  // Override built-in provider endpoints while preserving their models/auth.
  pi.registerProvider("anthropic", { baseUrl: v1 });
  pi.registerProvider("openai", { baseUrl: v1 });
}
`;
}
