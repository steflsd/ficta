import { existsSync, readFileSync } from "node:fs";
import type { FictaPlugin, PluginDiscovery, ProtectedValue } from "./types.js";

export interface KnownEnvFileStat {
  file: string;
  exists: boolean;
  loaded: number;
}

export type KnownEnvProcessMode = "disabled" | "secret-ish" | "all";

export interface KnownEnvStats {
  loaded: number;
  loadedFromEnvFiles: number;
  loadedFromProcessEnv: number;
  skippedEmpty: number;
  skippedTooShort: number;
  skippedNameFilter: number;
  skippedDuplicate: number;
  filesRead: number;
  filesMissing: number;
  envFileSetting: string;
  envFilesEnabled: boolean;
  envFiles: KnownEnvFileStat[];
  processEnvMode: KnownEnvProcessMode;
  processEnvEnabled: boolean;
  processEnvSecretishCandidates: number;
}

const PLUGIN_NAME = "known-env-values";
const DEFAULT_ENV_FILE = ".env:.env.local";
const SECRETISH_ENV_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|AUTH|BEARER|DATABASE|DB_URL|URL|JWT|PRIVATE|SIGNING|STRIPE|OPENAI|ANTHROPIC|AWS|GITHUB|DOPPLER|EMAIL|PHONE|IP)/i;

let cachedKey: string | undefined;
let cachedValues: ProtectedValue[] | undefined;
let cachedStats: KnownEnvStats | undefined;

export const knownEnvPlugin: FictaPlugin = {
  name: PLUGIN_NAME,
  description: "Loads exact secret/PII-ish values from .env files and process env",
  discover: discoverKnownEnvSources,
  loadValues: loadKnownEnvValues,
};

export function loadKnownEnvValues(): ProtectedValue[] {
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
      stats.filesRead++;
      for (const { name, value } of parseEnvFile(readFileSync(file, "utf8"))) {
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
      if (stats.processEnvMode !== "all" && !SECRETISH_ENV_NAME.test(name)) {
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

export function loadKnownEnvStats(): KnownEnvStats {
  loadKnownEnvValues();
  return cachedStats ?? emptyStats();
}

export function discoverKnownEnvSources(): PluginDiscovery[] {
  const stats = loadKnownEnvStats();
  return [envFileDiscovery(stats), processEnvDiscovery(stats)];
}

export function resetKnownEnvPluginCacheForTests(): void {
  cachedKey = undefined;
  cachedValues = undefined;
  cachedStats = undefined;
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

  const details = stats.envFiles.map((f) => `${f.file}: ${f.exists ? `${f.loaded} loaded` : "not found"}`);
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
    envFileSetting: registryEnvFileSetting(),
    envFilesEnabled: registryEnvFilesEnabled(),
    envFiles: [],
    processEnvMode: registryProcessEnvEnabled() ? registryProcessEnvMode() : "disabled",
    processEnvEnabled: registryProcessEnvEnabled(),
    processEnvSecretishCandidates: 0,
  };
}

function registryEnvFilesEnabled(): boolean {
  return enabled(process.env.FICTA_REGISTRY_ENV_FILE_ENABLED, true);
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
  return enabled(process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED, true);
}

function registryProcessEnvMode(): KnownEnvProcessMode {
  return process.env.FICTA_REGISTRY_PROCESS_ENV_MODE === "all" ? "all" : "secret-ish";
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
    if (value && SECRETISH_ENV_NAME.test(name)) n++;
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
    } else {
      value = stripComment(rawValue).trim();
    }

    out.push({ name, value });
  }
  return out;
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

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === "0" || value === "false" || value === "off" || value === "disabled") return false;
  if (value === "1" || value === "true" || value === "on" || value === "enabled") return true;
  return fallback;
}

function skippedOnlyMessage(stats: KnownEnvStats): string | undefined {
  const parts: string[] = [];
  if (stats.skippedTooShort > 0) parts.push(`${stats.skippedTooShort} shorter than ${registryMinLen()} chars`);
  if (stats.skippedDuplicate > 0) parts.push(`${stats.skippedDuplicate} duplicate`);
  if (stats.skippedEmpty > 0) parts.push(`${stats.skippedEmpty} empty`);
  return parts.length > 0 ? `skipped ${parts.join(", ")}` : undefined;
}
