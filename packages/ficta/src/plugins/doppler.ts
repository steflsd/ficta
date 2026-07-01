import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { envEnabled, parseBoolean } from "../env-flags.js";
import { findExecutable } from "../install.js";
import type { PluginDiscovery, ProtectedValue, RegistrySetupSource, RegistrySourcePlugin } from "./types.js";

type DopplerRegistryMode = "auto" | "enabled" | "disabled";
type DopplerSetupConfigMode = "current" | "all";

interface DopplerConfigStat {
  label: string;
  loaded: number;
  status: "loaded" | "empty" | "error";
}

interface DopplerStats {
  mode: DopplerRegistryMode;
  command: string;
  timeoutMs: number;
  configSetting: string;
  project?: string;
  attempted: boolean;
  configsAttempted: number;
  configsLoaded: number;
  loaded: number;
  skippedEmpty: number;
  skippedTooShort: number;
  skippedDuplicate: number;
  cliAvailable: boolean;
  exitCode?: number | null;
  timedOut: boolean;
  error?:
    | "missing_cli"
    | "unsafe_command"
    | "download_failed"
    | "config_list_failed"
    | "no_configs"
    | "invalid_json"
    | "unsupported_json";
  unsafeCommandReason?: string;
  configDetails: DopplerConfigStat[];
}

interface DopplerTarget {
  project?: string;
  config?: string;
  label: string;
}

interface DopplerCommandResult {
  ok: boolean;
  stdout: string;
  exitCode?: number | null;
  timedOut: boolean;
  error?: "missing_cli" | "unsafe_command" | "command_failed";
  message?: string;
}

const PLUGIN_NAME = "doppler-cli";
const DEFAULT_COMMAND = "doppler";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONFIG_SETTING = "current";

let cachedKey: string | undefined;
let cachedValues: ProtectedValue[] | undefined;
let cachedStats: DopplerStats | undefined;

export const dopplerPlugin: RegistrySourcePlugin = {
  kind: "registry-source",
  name: PLUGIN_NAME,
  description: "Loads exact secret values from Doppler at startup via the Doppler CLI",
  registryPolicy: {
    exclusions: [
      {
        id: "doppler-metadata-env-names",
        kind: "env-name",
        names: ["DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT", "DOPPLER_PROJECT"],
        reason: "Doppler routing/config metadata env vars are not secret material",
      },
    ],
  },
  config: {
    envDefaults: {
      FICTA_REGISTRY_DOPPLER_ENABLED: "1",
      FICTA_REGISTRY_DOPPLER_CONFIGS: DEFAULT_CONFIG_SETTING,
      FICTA_REGISTRY_DOPPLER_PROJECT: "",
      FICTA_REGISTRY_DOPPLER_TIMEOUT_MS: String(DEFAULT_TIMEOUT_MS),
    },
    bindings: [
      { env: "FICTA_REGISTRY_DOPPLER_ENABLED", path: ["registry", "doppler", "enabled"], kind: "boolean" },
      { env: "FICTA_REGISTRY_DOPPLER_CONFIGS", path: ["registry", "doppler", "configs"], kind: "string-array-comma" },
      { env: "FICTA_REGISTRY_DOPPLER_PROJECT", path: ["registry", "doppler", "project"], kind: "string" },
      { env: "FICTA_REGISTRY_DOPPLER_COMMAND", path: ["registry", "doppler", "command"], kind: "string" },
      { env: "FICTA_REGISTRY_DOPPLER_TIMEOUT_MS", path: ["registry", "doppler", "timeout_ms"], kind: "number" },
    ],
    sections: [{ path: ["registry", "doppler"], keys: ["enabled", "configs", "project", "command", "timeout_ms"] }],
  },
  setup: {
    registrySources: (ctx) => [dopplerSetupSource(ctx.env)],
  },
  discover: discoverDopplerSource,
  loadValues: loadDopplerValues,
};

function loadDopplerValues(): ProtectedValue[] {
  const key = cacheKey();
  if (cachedValues && cachedKey === key) return cachedValues;

  const stats = emptyStats();
  const values: ProtectedValue[] = [];
  const seen = new Set<string>();

  cachedKey = key;
  cachedValues = values;
  cachedStats = stats;

  if (stats.mode === "disabled") return values;

  const targets = resolveDopplerTargets(stats);
  if (!targets.ok) {
    stats.error = targets.error;
    return values;
  }

  const minLen = registryMinLen();
  for (const target of targets.targets) {
    stats.attempted = true;
    stats.configsAttempted++;

    const result = runDoppler(stats, secretsDownloadArgs(stats, target));
    updateCommandStats(stats, result);
    if (!result.ok) {
      stats.error ??= commandError(result.error, "download_failed");
      stats.configDetails.push({ label: target.label, loaded: 0, status: "error" });
      continue;
    }

    const parsed = parseDopplerSecretsJson(result.stdout);
    if (!parsed.ok) {
      stats.error ??= parsed.reason;
      stats.configDetails.push({ label: target.label, loaded: 0, status: "error" });
      continue;
    }

    let loadedForConfig = 0;
    for (const [name, value] of Object.entries(parsed.values)) {
      if (!name || !value) {
        stats.skippedEmpty++;
        continue;
      }
      if (value.length < minLen) {
        stats.skippedTooShort++;
        continue;
      }
      if (seen.has(value)) {
        stats.skippedDuplicate++;
        continue;
      }
      seen.add(value);
      loadedForConfig++;
      values.push({ name, value, source: "doppler", plugin: PLUGIN_NAME, kind: "secret", confidence: "exact" });
    }

    if (loadedForConfig > 0) stats.configsLoaded++;
    stats.configDetails.push({
      label: target.label,
      loaded: loadedForConfig,
      status: loadedForConfig > 0 ? "loaded" : "empty",
    });
  }

  values.sort((a, b) => b.value.length - a.value.length || a.name.localeCompare(b.name));
  stats.loaded = values.length;
  return values;
}

function discoverDopplerSource(): PluginDiscovery[] {
  const stats = loadDopplerStats();
  return [dopplerDiscovery(stats)];
}

function loadDopplerStats(): DopplerStats {
  loadDopplerValues();
  return cachedStats ?? emptyStats();
}

export function resetDopplerPluginCacheForTests(): void {
  cachedKey = undefined;
  cachedValues = undefined;
  cachedStats = undefined;
}

function dopplerSetupSource(env: NodeJS.ProcessEnv): RegistrySetupSource {
  const command = env.FICTA_REGISTRY_DOPPLER_COMMAND || DEFAULT_COMMAND;
  const executable = findExecutable(command, { pathEnv: env.PATH ?? "" });
  const label = executable
    ? `Doppler CLI — detected at ${executable}; load Doppler secrets before the agent starts`
    : `Doppler CLI — ${command} not found on PATH`;

  return {
    id: `${PLUGIN_NAME}/secrets-download`,
    label,
    defaultEnabled: envEnabled(env.FICTA_REGISTRY_DOPPLER_ENABLED, Boolean(executable)),
    async enabledValues(ctx) {
      const mode = await ctx.promptSelect<DopplerSetupConfigMode>(
        "Default Doppler coverage for each ficta launch",
        [
          { value: "all", label: "all configs in the resolved Doppler project" },
          { value: "current", label: "active config resolved by Doppler for the current directory" },
        ],
        configModeDefault(ctx.env.FICTA_REGISTRY_DOPPLER_CONFIGS),
      );
      return {
        FICTA_REGISTRY_DOPPLER_ENABLED: "1",
        FICTA_REGISTRY_DOPPLER_CONFIGS: mode,
        // Doppler resolves the project from the repo (.doppler.yaml / CLI config);
        // preserve any advanced env/config override but don't prompt for it.
        FICTA_REGISTRY_DOPPLER_PROJECT: ctx.env.FICTA_REGISTRY_DOPPLER_PROJECT ?? "",
      };
    },
    disabledValues(ctx) {
      return {
        FICTA_REGISTRY_DOPPLER_ENABLED: "0",
        FICTA_REGISTRY_DOPPLER_CONFIGS: DEFAULT_CONFIG_SETTING,
        FICTA_REGISTRY_DOPPLER_PROJECT: ctx.env.FICTA_REGISTRY_DOPPLER_PROJECT ?? "",
      };
    },
  };
}

function resolveDopplerTargets(
  stats: DopplerStats,
): { ok: true; targets: DopplerTarget[] } | { ok: false; error: NonNullable<DopplerStats["error"]> } {
  const setting = stats.configSetting.trim();
  if (!setting || setting === "current" || setting === "active") {
    return { ok: true, targets: [{ project: stats.project, label: targetLabel(stats.project, undefined) }] };
  }

  if (setting === "all") {
    stats.attempted = true;
    const result = runDoppler(stats, configsListArgs(stats));
    updateCommandStats(stats, result);
    if (!result.ok) {
      return { ok: false, error: commandError(result.error, "config_list_failed") };
    }

    const parsed = parseDopplerConfigsJson(result.stdout);
    if (!parsed.ok) return { ok: false, error: parsed.reason };
    if (parsed.configs.length === 0) return { ok: false, error: "no_configs" };

    return {
      ok: true,
      targets: parsed.configs.map((config) => ({
        project: stats.project,
        config,
        label: targetLabel(stats.project, config),
      })),
    };
  }

  const targets = setting
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((token): DopplerTarget => {
      const slash = token.indexOf("/");
      if (slash > 0) {
        const project = token.slice(0, slash);
        const config = token.slice(slash + 1);
        return { project, config, label: targetLabel(project, config) };
      }
      return { project: stats.project, config: token, label: targetLabel(stats.project, token) };
    });

  return targets.length > 0 ? { ok: true, targets } : { ok: false, error: "no_configs" };
}

function dopplerDiscovery(stats: DopplerStats): PluginDiscovery {
  if (stats.mode === "disabled") {
    return {
      id: `${PLUGIN_NAME}/secrets-download`,
      plugin: PLUGIN_NAME,
      label: "Doppler CLI",
      status: "disabled",
      valueCount: 0,
      message: "disabled by config/env (registry.doppler.enabled=false or FICTA_REGISTRY_DOPPLER_ENABLED=0)",
    };
  }

  const details = stats.configDetails.map(
    (d) => `${d.label}: ${d.status === "error" ? "error" : `${d.loaded} loaded`}`,
  );
  const skipped = skippedMessage(stats);

  if (stats.loaded > 0) {
    const scope =
      stats.configSetting === "current"
        ? "current config"
        : `${stats.configsLoaded}/${stats.configsAttempted} config(s)`;
    return {
      id: `${PLUGIN_NAME}/secrets-download`,
      plugin: PLUGIN_NAME,
      label: "Doppler CLI",
      status: stats.error ? "error" : "loaded",
      valueCount: stats.loaded,
      message: `loaded ${scope} via \`doppler secrets download --no-file --format json\`${stats.error ? "; some config(s) failed" : ""}${skipped}`,
      details,
    };
  }

  if (!stats.attempted) {
    return {
      id: `${PLUGIN_NAME}/secrets-download`,
      plugin: PLUGIN_NAME,
      label: "Doppler CLI",
      status: "not_found",
      valueCount: 0,
      message: "not attempted",
    };
  }

  if (stats.error === "missing_cli") {
    return {
      id: `${PLUGIN_NAME}/secrets-download`,
      plugin: PLUGIN_NAME,
      label: "Doppler CLI",
      status: "not_found",
      valueCount: 0,
      message: "doppler executable not found",
    };
  }

  if (stats.error === "unsafe_command") {
    return {
      id: `${PLUGIN_NAME}/secrets-download`,
      plugin: PLUGIN_NAME,
      label: "Doppler CLI",
      status: "error",
      valueCount: 0,
      message: `refused to run untrusted Doppler command${stats.unsafeCommandReason ? `: ${stats.unsafeCommandReason}` : ""}`,
    };
  }

  if (stats.error === "invalid_json" || stats.error === "unsupported_json") {
    return {
      id: `${PLUGIN_NAME}/secrets-download`,
      plugin: PLUGIN_NAME,
      label: "Doppler CLI",
      status: "error",
      valueCount: 0,
      message: "Doppler CLI returned non-JSON or unsupported JSON output",
      details,
    };
  }

  if (stats.error === "config_list_failed") {
    return {
      id: `${PLUGIN_NAME}/secrets-download`,
      plugin: PLUGIN_NAME,
      label: "Doppler CLI",
      status: "error",
      valueCount: 0,
      message: 'could not list Doppler configs for registry.doppler.configs="all"',
    };
  }

  if (stats.error === "no_configs") {
    return {
      id: `${PLUGIN_NAME}/secrets-download`,
      plugin: PLUGIN_NAME,
      label: "Doppler CLI",
      status: "not_found",
      valueCount: 0,
      message: "no Doppler configs found",
    };
  }

  if (stats.configsAttempted > 0 && (stats.skippedTooShort > 0 || stats.skippedEmpty > 0)) {
    return {
      id: `${PLUGIN_NAME}/secrets-download`,
      plugin: PLUGIN_NAME,
      label: "Doppler CLI",
      status: "available",
      valueCount: 0,
      message: `Doppler secrets found but no values met the filters${skipped}`,
      details,
    };
  }

  const timeout = stats.timedOut ? " within timeout" : "";
  return {
    id: `${PLUGIN_NAME}/secrets-download`,
    plugin: PLUGIN_NAME,
    label: "Doppler CLI",
    status: "not_found",
    valueCount: 0,
    message: `no Doppler secrets loaded${timeout}; configure Doppler or disable with registry.doppler.enabled=false`,
    details,
  };
}

function emptyStats(): DopplerStats {
  const project = process.env.FICTA_REGISTRY_DOPPLER_PROJECT || undefined;
  return {
    mode: registryDopplerMode(),
    command: process.env.FICTA_REGISTRY_DOPPLER_COMMAND || DEFAULT_COMMAND,
    timeoutMs: registryDopplerTimeoutMs(),
    configSetting: registryDopplerConfigSetting(),
    project,
    attempted: false,
    configsAttempted: 0,
    configsLoaded: 0,
    loaded: 0,
    skippedEmpty: 0,
    skippedTooShort: 0,
    skippedDuplicate: 0,
    cliAvailable: false,
    timedOut: false,
    configDetails: [],
  };
}

function configModeDefault(value: string | undefined): DopplerSetupConfigMode {
  return value === "current" ? "current" : "all";
}

function commandError(
  error: DopplerCommandResult["error"],
  fallback: "download_failed" | "config_list_failed",
): NonNullable<DopplerStats["error"]> {
  if (error === "missing_cli" || error === "unsafe_command") return error;
  return fallback;
}

function registryDopplerMode(): DopplerRegistryMode {
  const parsed = parseBoolean(process.env.FICTA_REGISTRY_DOPPLER_ENABLED ?? "1");
  if (parsed === false) return "disabled";
  if (parsed === true) return "enabled";
  return "auto";
}

function registryDopplerConfigSetting(): string {
  return (process.env.FICTA_REGISTRY_DOPPLER_CONFIGS || DEFAULT_CONFIG_SETTING).trim() || DEFAULT_CONFIG_SETTING;
}

function registryDopplerTimeoutMs(): number {
  const raw = Number(process.env.FICTA_REGISTRY_DOPPLER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(250, Math.floor(raw));
}

function registryMinLen(): number {
  const raw = Number(process.env.FICTA_REGISTRY_MIN_LEN ?? 8);
  if (!Number.isFinite(raw) || raw < 0) return 8;
  return raw;
}

function cacheKey(): string {
  return JSON.stringify({
    enabled: process.env.FICTA_REGISTRY_DOPPLER_ENABLED ?? "1",
    mode: registryDopplerMode(),
    command: process.env.FICTA_REGISTRY_DOPPLER_COMMAND || DEFAULT_COMMAND,
    timeoutMs: registryDopplerTimeoutMs(),
    configSetting: registryDopplerConfigSetting(),
    project: process.env.FICTA_REGISTRY_DOPPLER_PROJECT ?? "",
    minLen: registryMinLen(),
    cwd: process.cwd(),
    path: process.env.PATH ?? "",
    dopplerProject: process.env.DOPPLER_PROJECT ?? "",
    dopplerConfig: process.env.DOPPLER_CONFIG ?? "",
    dopplerEnvironment: process.env.DOPPLER_ENVIRONMENT ?? "",
    hasDopplerToken: process.env.DOPPLER_TOKEN ? "1" : "0",
  });
}

function runDoppler(stats: DopplerStats, args: string[]): DopplerCommandResult {
  const resolved = resolveDopplerCommand(stats.command);
  if (!resolved.ok) {
    return {
      ok: false,
      stdout: "",
      timedOut: false,
      error: resolved.error,
      message: resolved.message,
    };
  }

  const result = spawnSync(resolved.path, args, {
    cwd: process.cwd(),
    env: dopplerChildEnv(process.env),
    encoding: "utf8",
    timeout: stats.timeoutMs,
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true,
  });

  if (result.error) {
    const missing = result.error.message.includes("ENOENT");
    return {
      ok: false,
      stdout: "",
      exitCode: result.status,
      timedOut: result.error.message.includes("ETIMEDOUT") || result.signal === "SIGTERM",
      error: missing ? "missing_cli" : "command_failed",
    };
  }

  return {
    ok: result.status === 0,
    stdout: result.stdout,
    exitCode: result.status,
    timedOut: result.signal === "SIGTERM",
    error: result.status === 0 ? undefined : "command_failed",
  };
}

function updateCommandStats(stats: DopplerStats, result: DopplerCommandResult): void {
  stats.cliAvailable = result.error !== "missing_cli";
  stats.exitCode = result.exitCode;
  stats.timedOut ||= result.timedOut;
  if (result.error === "unsafe_command") stats.unsafeCommandReason = result.message;
}

function resolveDopplerCommand(
  command: string,
): { ok: true; path: string } | { ok: false; error: "missing_cli" | "unsafe_command"; message: string } {
  const executable = findExecutable(command, { pathEnv: process.env.PATH ?? "" });
  if (!executable) return { ok: false, error: "missing_cli", message: "doppler executable not found" };

  const unsafe = unsafeExecutableReason(executable);
  if (unsafe) return { ok: false, error: "unsafe_command", message: unsafe };
  return { ok: true, path: executable };
}

function unsafeExecutableReason(executable: string): string | undefined {
  const resolvedExecutable = realpathSync(resolve(executable));
  const cwd = realpathSync(resolve(process.cwd()));
  const rel = relative(cwd, resolvedExecutable);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return `resolved inside the current working tree (${rel})`;
  }

  try {
    const stat = statSync(resolvedExecutable);
    if ((stat.mode & 0o002) !== 0) return `resolved to world-writable executable (${resolvedExecutable})`;
  } catch {
    return `could not stat executable (${resolvedExecutable})`;
  }

  const executableDir = dirname(resolvedExecutable);
  try {
    const stat = statSync(executableDir);
    if ((stat.mode & 0o002) !== 0) return `resolved from world-writable directory (${executableDir})`;
  } catch {
    return `could not stat executable directory (${executableDir})`;
  }
  return undefined;
}

function dopplerChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { DOPPLER_NO_UPDATE_CHECK: "1" };
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "APPDATA",
    "LOCALAPPDATA",
  ]) {
    if (env[key]) out[key] = env[key];
  }

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (key.startsWith("DOPPLER_") || /^(HTTPS?|ALL)_PROXY$/i.test(key) || /^NO_PROXY$/i.test(key)) {
      out[key] = value;
    }
  }
  return out;
}

function secretsDownloadArgs(stats: DopplerStats, target: DopplerTarget): string[] {
  const args = [
    "secrets",
    "download",
    "--no-file",
    "--format",
    "json",
    "--no-fallback",
    "--no-check-version",
    "--silent",
    "--attempts",
    "1",
    "--timeout",
    `${Math.max(1, Math.ceil(stats.timeoutMs / 1000))}s`,
  ];
  if (target.project) args.push("--project", target.project);
  if (target.config) args.push("--config", target.config);
  return args;
}

function configsListArgs(stats: DopplerStats): string[] {
  const args = [
    "configs",
    "--json",
    "--no-check-version",
    "--silent",
    "--attempts",
    "1",
    "--timeout",
    `${Math.max(1, Math.ceil(stats.timeoutMs / 1000))}s`,
  ];
  if (stats.project) args.push("--project", stats.project);
  return args;
}

function parseDopplerSecretsJson(
  stdout: string,
): { ok: true; values: Record<string, string> } | { ok: false; reason: "invalid_json" | "unsupported_json" } {
  const text = stdout.trim();
  if (!text) return { ok: false, reason: "invalid_json" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "unsupported_json" };
  }

  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string") values[name] = value;
  }
  return { ok: true, values };
}

function parseDopplerConfigsJson(
  stdout: string,
): { ok: true; configs: string[] } | { ok: false; reason: "invalid_json" | "unsupported_json" } {
  const text = stdout.trim();
  if (!text) return { ok: false, reason: "invalid_json" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const configs = extractConfigNames(parsed);
  return configs ? { ok: true, configs } : { ok: false, reason: "unsupported_json" };
}

function extractConfigNames(value: unknown): string[] | undefined {
  const roots: unknown[] = [];
  if (Array.isArray(value)) roots.push(value);
  else if (value && typeof value === "object") {
    for (const key of ["configs", "data", "items", "results"]) {
      const child = (value as Record<string, unknown>)[key];
      if (Array.isArray(child)) roots.push(child);
    }
    if (roots.length === 0) roots.push(Object.values(value));
  } else return undefined;

  const out = new Set<string>();
  for (const root of roots) {
    if (!Array.isArray(root)) continue;
    for (const item of root) {
      const name = configNameFromItem(item);
      if (name) out.add(name);
    }
  }
  return [...out].sort();
}

function configNameFromItem(item: unknown): string | undefined {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const obj = item as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if ((normalized === "name" || normalized === "config" || normalized === "slug") && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function targetLabel(project: string | undefined, config: string | undefined): string {
  if (project && config) return `${project}/${config}`;
  if (config) return config;
  if (project) return `${project}/current`;
  return "current";
}

function skippedMessage(stats: DopplerStats): string {
  const parts: string[] = [];
  if (stats.skippedTooShort > 0) parts.push(`${stats.skippedTooShort} shorter than ${registryMinLen()} chars`);
  if (stats.skippedDuplicate > 0) parts.push(`${stats.skippedDuplicate} duplicate`);
  if (stats.skippedEmpty > 0) parts.push(`${stats.skippedEmpty} empty`);
  return parts.length > 0 ? `; skipped ${parts.join(", ")}` : "";
}
