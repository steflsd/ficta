import { existsSync, readFileSync } from "node:fs";
import { envEnabled } from "../env-flags.js";
import type { PluginDiscovery, ProtectedValue, RegistrySetupSource, RegistrySourcePlugin } from "./types.js";

interface KnownEnvFileStat {
  file: string;
  exists: boolean;
  loaded: number;
  error?: string;
}

type KnownEnvProcessMode = "disabled" | "secret-ish" | "all";

interface KnownEnvStats {
  loaded: number;
  loadedFromEnvFiles: number;
  loadedFromProcessEnv: number;
  skippedEmpty: number;
  skippedTooShort: number;
  skippedNameFilter: number;
  skippedDuplicate: number;
  filesRead: number;
  filesMissing: number;
  filesErrored: number;
  envFileSetting: string;
  envFilesEnabled: boolean;
  envFiles: KnownEnvFileStat[];
  processEnvMode: KnownEnvProcessMode;
  processEnvEnabled: boolean;
  processEnvSecretishCandidates: number;
}

const PLUGIN_NAME = "known-env-values";
const DEFAULT_ENV_FILE = ".env:.env.local";
const DEFAULT_ENV_FILE_ENABLED = "1";
const DEFAULT_PROCESS_ENV_ENABLED = "1";
const DEFAULT_PROCESS_ENV_MODE = "secret-ish";
// Positive secret-ish heuristic. Precise non-secret carve-outs (e.g. Doppler's DOPPLER_CONFIG
// routing metadata) are handled by trusted registry-policy exclusions, not by narrowing this list.
// `PWD` matches every credential abbreviation form (DB_PWD, MYSQLPWD, ADMINPWD, PWDHASH, …); the
// only `PWD`-bearing names that are NOT secrets are the shell's own working-directory vars, which
// are excluded by exact name below rather than by removing `PWD` from this list.
const SECRETISH_ENV_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|AUTH|BEARER|DATABASE|DB_URL|URL|JWT|PRIVATE|SIGNING|STRIPE|OPENAI|ANTHROPIC|AWS|GITHUB|DOPPLER|EMAIL|PHONE|IP)/i;

// Shell-provided working-directory vars contain `PWD` but are paths, not secrets; excluding them by
// exact name keeps the broad `PWD` match above from registering the cwd as a protected value.
const SHELL_NON_SECRET_ENV_NAMES = new Set(["PWD", "OLDPWD"]);

function isSecretishEnvName(name: string): boolean {
  if (SHELL_NON_SECRET_ENV_NAMES.has(name.toUpperCase())) return false;
  return SECRETISH_ENV_NAME.test(name);
}

let cachedKey: string | undefined;
let cachedValues: ProtectedValue[] | undefined;
let cachedStats: KnownEnvStats | undefined;

export const knownEnvPlugin: RegistrySourcePlugin = {
  kind: "registry-source",
  name: PLUGIN_NAME,
  description: "Loads exact secret/PII-ish values from .env files and process env",
  config: {
    envDefaults: {
      FICTA_REGISTRY_ENV_FILE_ENABLED: DEFAULT_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: DEFAULT_ENV_FILE,
      FICTA_REGISTRY_PROCESS_ENV_ENABLED: DEFAULT_PROCESS_ENV_ENABLED,
      FICTA_REGISTRY_PROCESS_ENV_MODE: DEFAULT_PROCESS_ENV_MODE,
    },
    bindings: [
      { env: "FICTA_REGISTRY_ENV_FILE_ENABLED", path: ["registry", "env_file", "enabled"], kind: "boolean" },
      { env: "FICTA_REGISTRY_ENV_FILE_PATHS", path: ["registry", "env_file", "paths"], kind: "string-array-colon" },
      { env: "FICTA_REGISTRY_PROCESS_ENV_ENABLED", path: ["registry", "process_env", "enabled"], kind: "boolean" },
      { env: "FICTA_REGISTRY_PROCESS_ENV_MODE", path: ["registry", "process_env", "mode"], kind: "string" },
    ],
    sections: [
      { path: ["registry", "env_file"], keys: ["enabled", "paths"] },
      { path: ["registry", "process_env"], keys: ["enabled", "mode"] },
    ],
  },
  setup: {
    registryDefaults: () => ({
      FICTA_REGISTRY_PROCESS_ENV_ENABLED: DEFAULT_PROCESS_ENV_ENABLED,
      FICTA_REGISTRY_PROCESS_ENV_MODE: DEFAULT_PROCESS_ENV_MODE,
    }),
    registrySources: (ctx) => [envFileSetupSource(ctx.env)],
  },
  discover: discoverKnownEnvSources,
  loadValues: loadKnownEnvValues,
};

function loadKnownEnvValues(): ProtectedValue[] {
  const key = cacheKey();
  if (cachedValues && cachedKey === key) return cachedValues;

  const minLen = registryMinLen();
  const values: ProtectedValue[] = [];
  const seen = new Set<string>();
  const stats = emptyStats();

  const add = (name: string, value: string, source: "env-file" | "process-env"): boolean => {
    if (!name || !value) {
      stats.skippedEmpty++;
      return false;
    }
    if (value.length < minLen) {
      stats.skippedTooShort++;
      return false;
    }
    const key = `${source}\0${name}\0${value}`;
    if (seen.has(key)) {
      stats.skippedDuplicate++;
      return false;
    }
    seen.add(key);
    values.push({ name, value, source, plugin: PLUGIN_NAME, kind: "secret", confidence: "exact" });
    if (source === "env-file") stats.loadedFromEnvFiles++;
    else stats.loadedFromProcessEnv++;
    return true;
  };

  stats.envFileSetting = registryEnvFileSetting();
  stats.envFilesEnabled = registryEnvFilesEnabled();
  if (stats.envFilesEnabled) {
    for (const file of stats.envFileSetting.split(":").filter(Boolean)) {
      const fileStat: KnownEnvFileStat = { file, exists: existsSync(file), loaded: 0 };
      stats.envFiles.push(fileStat);
      if (!fileStat.exists) {
        stats.filesMissing++;
        continue;
      }
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        stats.filesErrored++;
        fileStat.error = "read error";
        continue;
      }
      stats.filesRead++;
      for (const { name, value } of parseEnvFile(text)) {
        if (add(name, value, "env-file")) fileStat.loaded++;
      }
    }
  }

  stats.processEnvSecretishCandidates = countSecretishProcessEnvCandidates();
  stats.processEnvEnabled = registryProcessEnvEnabled();
  stats.processEnvMode = stats.processEnvEnabled ? registryProcessEnvMode() : "disabled";

  if (stats.processEnvMode !== "disabled") {
    for (const [name, value] of Object.entries(process.env)) {
      if (!value) {
        stats.skippedEmpty++;
        continue;
      }
      if (stats.processEnvMode !== "all" && !isSecretishEnvName(name)) {
        stats.skippedNameFilter++;
        continue;
      }
      add(name, value, "process-env");
    }
  }

  // Longer first makes overlapping values easier to reason about in metadata.
  cachedValues = values.sort((a, b) => b.value.length - a.value.length || a.name.localeCompare(b.name));
  cachedStats = { ...stats, loaded: cachedValues.length };
  cachedKey = key;
  return cachedValues;
}

function loadKnownEnvStats(): KnownEnvStats {
  loadKnownEnvValues();
  return cachedStats ?? emptyStats();
}

function discoverKnownEnvSources(): PluginDiscovery[] {
  const stats = loadKnownEnvStats();
  return [envFileDiscovery(stats), processEnvDiscovery(stats)];
}

export function resetKnownEnvPluginCacheForTests(): void {
  cachedKey = undefined;
  cachedValues = undefined;
  cachedStats = undefined;
}

function envFileSetupSource(env: NodeJS.ProcessEnv): RegistrySetupSource {
  const envFilePaths = (env.FICTA_REGISTRY_ENV_FILE_PATHS ?? DEFAULT_ENV_FILE).split(":").filter(Boolean);
  const existingEnvFiles = envFilePaths.filter((path) => existsSync(path));
  const label =
    existingEnvFiles.length > 0
      ? `.env files — found ${existingEnvFiles.join(", ")}`
      : `.env files — load project env files (${envFilePaths.join(":")})`;

  return {
    id: `${PLUGIN_NAME}/env-file`,
    label,
    defaultEnabled: envEnabled(env.FICTA_REGISTRY_ENV_FILE_ENABLED, true),
    async enabledValues(ctx) {
      const paths = await ctx.promptText(
        "Env files to load",
        ctx.env.FICTA_REGISTRY_ENV_FILE_PATHS ?? DEFAULT_ENV_FILE,
        "Colon-separated paths, relative to the repo where the agent starts.",
      );
      return {
        FICTA_REGISTRY_ENV_FILE_ENABLED: "1",
        FICTA_REGISTRY_ENV_FILE_PATHS: paths,
      };
    },
    disabledValues(ctx) {
      return {
        FICTA_REGISTRY_ENV_FILE_ENABLED: "0",
        FICTA_REGISTRY_ENV_FILE_PATHS: ctx.env.FICTA_REGISTRY_ENV_FILE_PATHS ?? DEFAULT_ENV_FILE,
      };
    },
  };
}

function envFileDiscovery(stats: KnownEnvStats): PluginDiscovery {
  if (!stats.envFilesEnabled) {
    return {
      id: `${PLUGIN_NAME}/env-file`,
      plugin: PLUGIN_NAME,
      label: "env files",
      status: "disabled",
      valueCount: 0,
      message: "disabled by config/env (registry.env_file.enabled=false or FICTA_REGISTRY_ENV_FILE_ENABLED=0)",
    };
  }

  const details = stats.envFiles.map(
    (f) => `${f.file}: ${f.error ? f.error : f.exists ? `${f.loaded} loaded` : "not found"}`,
  );
  if (stats.filesErrored > 0) {
    if (stats.loadedFromEnvFiles > 0) {
      return {
        id: `${PLUGIN_NAME}/env-file`,
        plugin: PLUGIN_NAME,
        label: "env files",
        status: "error",
        valueCount: stats.loadedFromEnvFiles,
        message: `loaded ${stats.loadedFromEnvFiles} value(s), but could not read ${stats.filesErrored} env file(s)`,
        details,
      };
    }
    return {
      id: `${PLUGIN_NAME}/env-file`,
      plugin: PLUGIN_NAME,
      label: "env files",
      status: "error",
      valueCount: 0,
      message: `could not read ${stats.filesErrored} env file(s)`,
      details,
    };
  }
  if (stats.loadedFromEnvFiles > 0) {
    return {
      id: `${PLUGIN_NAME}/env-file`,
      plugin: PLUGIN_NAME,
      label: "env files",
      status: "loaded",
      valueCount: stats.loadedFromEnvFiles,
      message: `read ${stats.filesRead} file(s)`,
      details,
    };
  }
  if (stats.filesRead > 0) {
    return {
      id: `${PLUGIN_NAME}/env-file`,
      plugin: PLUGIN_NAME,
      label: "env files",
      status: "available",
      valueCount: 0,
      message: skippedOnlyMessage(stats) ?? "file(s) found but no values met the filters",
      details,
    };
  }
  return {
    id: `${PLUGIN_NAME}/env-file`,
    plugin: PLUGIN_NAME,
    label: "env files",
    status: "not_found",
    valueCount: 0,
    message: `looked for ${stats.envFileSetting}`,
    details,
  };
}

function processEnvDiscovery(stats: KnownEnvStats): PluginDiscovery {
  if (stats.processEnvMode !== "disabled") {
    const mode = stats.processEnvMode === "all" ? "all env vars" : "secret-ish env names";
    return {
      id: `${PLUGIN_NAME}/process-env`,
      plugin: PLUGIN_NAME,
      label: "process env",
      status: stats.loadedFromProcessEnv > 0 ? "loaded" : "not_found",
      valueCount: stats.loadedFromProcessEnv,
      message: `enabled for ${mode}${skippedOnlyMessage(stats) ? `; ${skippedOnlyMessage(stats)}` : ""}`,
    };
  }

  if (stats.processEnvSecretishCandidates > 0) {
    return {
      id: `${PLUGIN_NAME}/process-env`,
      plugin: PLUGIN_NAME,
      label: "process env",
      status: "available",
      valueCount: 0,
      message: `${stats.processEnvSecretishCandidates} secret-ish env var name(s) detected; enable with registry.process_env.enabled=true or FICTA_REGISTRY_PROCESS_ENV_ENABLED=1`,
    };
  }

  return {
    id: `${PLUGIN_NAME}/process-env`,
    plugin: PLUGIN_NAME,
    label: "process env",
    status: "disabled",
    valueCount: 0,
    message: "disabled by config/env (registry.process_env.enabled=false or FICTA_REGISTRY_PROCESS_ENV_ENABLED=0)",
  };
}

function emptyStats(): KnownEnvStats {
  return {
    loaded: 0,
    loadedFromEnvFiles: 0,
    loadedFromProcessEnv: 0,
    skippedEmpty: 0,
    skippedTooShort: 0,
    skippedNameFilter: 0,
    skippedDuplicate: 0,
    filesRead: 0,
    filesMissing: 0,
    filesErrored: 0,
    envFileSetting: registryEnvFileSetting(),
    envFilesEnabled: registryEnvFilesEnabled(),
    envFiles: [],
    processEnvMode: registryProcessEnvEnabled() ? registryProcessEnvMode() : "disabled",
    processEnvEnabled: registryProcessEnvEnabled(),
    processEnvSecretishCandidates: 0,
  };
}

function registryEnvFilesEnabled(): boolean {
  return envEnabled(process.env.FICTA_REGISTRY_ENV_FILE_ENABLED, DEFAULT_ENV_FILE_ENABLED === "1");
}

function registryEnvFileSetting(): string {
  return process.env.FICTA_REGISTRY_ENV_FILE_PATHS ?? DEFAULT_ENV_FILE;
}

function registryMinLen(): number {
  const raw = Number(process.env.FICTA_REGISTRY_MIN_LEN ?? 8);
  if (!Number.isFinite(raw) || raw < 0) return 8;
  return raw;
}

function registryProcessEnvEnabled(): boolean {
  return envEnabled(process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED, DEFAULT_PROCESS_ENV_ENABLED === "1");
}

function registryProcessEnvMode(): KnownEnvProcessMode {
  return process.env.FICTA_REGISTRY_PROCESS_ENV_MODE === "all" ? "all" : DEFAULT_PROCESS_ENV_MODE;
}

function cacheKey(): string {
  return JSON.stringify({
    envFilesEnabled: registryEnvFilesEnabled(),
    envFile: registryEnvFileSetting(),
    minLen: registryMinLen(),
    processEnvEnabled: registryProcessEnvEnabled(),
    processEnvMode: registryProcessEnvMode(),
  });
}

function countSecretishProcessEnvCandidates(): number {
  let n = 0;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && isSecretishEnvName(name)) n++;
  }
  return n;
}

function parseEnvFile(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;

    const name = m[1] ?? "";
    const rawValue = m[2] ?? "";
    const trimmed = rawValue.trimStart();
    const quote = trimmed[0];
    let value: string;

    if (quote === '"' || quote === "'") {
      let quoted = trimmed;
      let close = closingQuoteIndex(quoted, quote);
      while (close === -1 && i + 1 < lines.length) {
        i++;
        quoted += "\n" + (lines[i] ?? "");
        close = closingQuoteIndex(quoted, quote);
      }
      // If the quote never closes, keep the accumulated content after the opener rather than
      // silently registering only the first physical line.
      value = close === -1 ? quoted.slice(1) : quoted.slice(1, close);
      if (quote === '"') value = unescapeDoubleQuotedEnv(value);
    } else {
      value = stripComment(rawValue).trim();
    }

    out.push({ name, value });
  }
  return out;
}

function unescapeDoubleQuotedEnv(value: string): string {
  return value.replace(/\\([nrt"\\$])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function closingQuoteIndex(value: string, quote: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === quote && !isEscaped(value, i)) return i;
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let n = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

function stripComment(value: string): string {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && !isEscaped(value, i)) {
      quote = quote === ch ? undefined : (quote ?? ch);
      continue;
    }
    if (ch === "#" && !quote) {
      const prev = value[i - 1];
      if (i === 0 || prev === undefined || /\s/.test(prev)) return value.slice(0, i);
    }
  }
  return value;
}

function skippedOnlyMessage(stats: KnownEnvStats): string | undefined {
  const parts: string[] = [];
  if (stats.skippedTooShort > 0) parts.push(`${stats.skippedTooShort} shorter than ${registryMinLen()} chars`);
  if (stats.skippedDuplicate > 0) parts.push(`${stats.skippedDuplicate} duplicate`);
  if (stats.skippedEmpty > 0) parts.push(`${stats.skippedEmpty} empty`);
  return parts.length > 0 ? `skipped ${parts.join(", ")}` : undefined;
}
