import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pluginConfigBindings, pluginConfigSections } from "./plugins/index.js";
import type { ConfigBinding, ConfigBindingKind, ConfigSection } from "./plugins/types.js";

type TomlScalar = string | number | boolean;
type TomlValue = TomlScalar | TomlScalar[];
type TomlTable = { [key: string]: TomlValue | TomlTable };

const CORE_CONFIG_BINDINGS: readonly ConfigBinding[] = [
  { env: "FICTA_REGISTRY_MIN_LEN", path: ["registry", "min_len"], kind: "number" },
  { env: "FICTA_REQUIRE_REGISTRY", path: ["registry", "require"], kind: "boolean" },
  { env: "FICTA_FAIL_CLOSED", path: ["redaction", "fail_closed"], kind: "boolean" },
  { env: "FICTA_REDACT_PATHS", path: ["redaction", "redact_paths"], kind: "boolean" },
  { env: "FICTA_LOG_BODIES", path: ["logging", "log_bodies"], kind: "boolean" },
  { env: "FICTA_LOG_DIR", path: ["logging", "log_dir"], kind: "string" },
  { env: "FICTA_SURROGATE_KEY", path: ["surrogate", "key"], kind: "string" },
  { env: "FICTA_PORT", path: ["runtime", "port"], kind: "number" },
  { env: "FICTA_QUIET", path: ["runtime", "quiet"], kind: "boolean" },
  { env: "FICTA_ANTHROPIC_UPSTREAM", path: ["upstreams", "anthropic"], kind: "string" },
  { env: "FICTA_OPENAI_UPSTREAM", path: ["upstreams", "openai"], kind: "string" },
  { env: "FICTA_CHATGPT_UPSTREAM", path: ["upstreams", "chatgpt"], kind: "string" },
  { env: "FICTA_UPSTREAM", path: ["upstreams", "forced"], kind: "string" },
];

const CORE_SECTION_ORDER: readonly ConfigSection[] = [
  { path: ["registry"], keys: ["min_len", "require"] },
  { path: ["redaction"], keys: ["fail_closed", "redact_paths"] },
  { path: ["logging"], keys: ["log_bodies", "log_dir"] },
  { path: ["surrogate"], keys: ["key"] },
  { path: ["runtime"], keys: ["port", "quiet"] },
  { path: ["upstreams"], keys: ["anthropic", "openai", "chatgpt", "forced"] },
];

function configBindings(): ConfigBinding[] {
  return [...CORE_CONFIG_BINDINGS, ...pluginConfigBindings()];
}

function configSectionOrder(): ConfigSection[] {
  const [registry, ...rest] = CORE_SECTION_ORDER;
  return registry ? [registry, ...pluginConfigSections(), ...rest] : [...pluginConfigSections(), ...rest];
}

let loaded = false;

export function defaultConfigPath(): string {
  return join(homedir(), ".ficta", "config.toml");
}

export function configPath(): string | undefined {
  const setting = process.env.FICTA_CONFIG_FILE;
  if (setting === "0") return undefined;
  return setting ? expandHome(setting) : defaultConfigPath();
}

/** Load ~/.ficta/config.toml into process.env-style runtime settings without overriding explicit env vars. */
export function loadUserConfig(): void {
  if (loaded) return;
  loaded = true;

  const path = configPath();
  if (!path || !existsSync(path)) return;

  for (const [key, value] of Object.entries(readUserConfig(path))) {
    process.env[key] ??= value;
  }
}

/** Test helper for modules that need to reload a temp config file in one process. */
export function resetUserConfigForTests(): void {
  loaded = false;
}

export function writeUserConfig(values: Record<string, string>, path = defaultConfigPath()): void {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, renderToml(values), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
}

/** Read an existing TOML config file into the effective FICTA_* setting map (empty if missing). */
export function readUserConfig(path = defaultConfigPath()): Record<string, string> {
  if (!path || !existsSync(path)) return {};
  return configObjectToEnv(parseToml(readFileSync(path, "utf8")));
}

/**
 * Ensure a stable local surrogate key exists, so surrogates stay consistent across sessions.
 * No-op if one is already active (env or config file). Otherwise generates a 256-bit key, persists
 * it 0600 (merging with any existing config), and activates it for the current process. The key
 * never leaves the machine and is never printed.
 */
export function ensureSurrogateKey(path = configPath()): { generated: boolean; path?: string } {
  if (process.env.FICTA_SURROGATE_KEY) return { generated: false, path };
  if (!path) return { generated: false }; // config file disabled (FICTA_CONFIG_FILE=0)
  const values = readUserConfig(path);
  if (values.FICTA_SURROGATE_KEY) {
    process.env.FICTA_SURROGATE_KEY = values.FICTA_SURROGATE_KEY;
    return { generated: false, path };
  }
  const key = randomBytes(32).toString("hex");
  values.FICTA_SURROGATE_KEY = key;
  writeUserConfig(values, path);
  process.env.FICTA_SURROGATE_KEY = key;
  return { generated: true, path };
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
}

function renderToml(values: Record<string, string>): string {
  const tree = envToConfigObject(values);
  const lines = ["# Generated by ficta.", "# Shell environment variables override this file."];

  for (const section of configSectionOrder()) appendSection(lines, tree, section.path, section.keys);
  return `${lines.join("\n")}\n`;
}

function appendSection(lines: string[], root: TomlTable, path: readonly string[], keys: readonly string[]): void {
  const table = getTable(root, path);
  if (!table) return;
  const entries = keys
    .map((key): [string, TomlValue | undefined] => [key, tomlValue(table[key])])
    .filter((entry): entry is [string, TomlValue] => entry[1] !== undefined);
  if (entries.length === 0) return;

  lines.push("", `[${path.join(".")}]`);
  for (const [key, value] of entries) lines.push(`${key} = ${formatTomlValue(value)}`);
}

function envToConfigObject(values: Record<string, string>): TomlTable {
  const root: TomlTable = {};
  for (const binding of configBindings()) {
    if (!Object.hasOwn(values, binding.env)) continue;
    setPath(root, binding.path, envValueToToml(values[binding.env] ?? "", binding.kind));
  }
  return root;
}

function configObjectToEnv(root: TomlTable): Record<string, string> {
  const out: Record<string, string> = {};
  for (const binding of configBindings()) {
    const value = getPath(root, binding.path);
    const envValue = value === undefined ? undefined : tomlValueToEnv(value, binding.kind);
    if (envValue !== undefined) out[binding.env] = envValue;
  }
  return out;
}

function envValueToToml(value: string, kind: ConfigBindingKind): TomlValue {
  switch (kind) {
    case "boolean":
      return parseBoolean(value) ?? value;
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case "string-array-colon":
      return value.split(":").filter(Boolean);
    case "string-array-comma": {
      const trimmed = value.trim();
      if (trimmed.includes(","))
        return trimmed
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean);
      return trimmed;
    }
    case "string":
      return value;
  }
}

function tomlValueToEnv(value: TomlValue | TomlTable, kind: ConfigBindingKind): string | undefined {
  if (tomlValue(value) === undefined) return undefined;
  switch (kind) {
    case "boolean": {
      if (typeof value === "boolean") return value ? "1" : "0";
      const parsed = typeof value === "string" ? parseBoolean(value) : undefined;
      return parsed === undefined ? String(value) : parsed ? "1" : "0";
    }
    case "number":
      return String(value);
    case "string-array-colon":
      return Array.isArray(value) ? value.map(String).join(":") : String(value);
    case "string-array-comma":
      return Array.isArray(value) ? value.map(String).join(",") : String(value);
    case "string":
      return String(value);
  }
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "enabled", "yes"].includes(normalized)) return true;
  if (["0", "false", "off", "disabled", "no"].includes(normalized)) return false;
  return undefined;
}

function getTable(root: TomlTable, path: readonly string[]): TomlTable | undefined {
  let cursor: TomlTable = root;
  for (const part of path) {
    const next = cursor[part];
    if (!isTable(next)) return undefined;
    cursor = next;
  }
  return cursor;
}

function getPath(root: TomlTable, path: readonly string[]): TomlValue | TomlTable | undefined {
  let cursor: TomlValue | TomlTable | undefined = root;
  for (const part of path) {
    if (!isTable(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(root: TomlTable, path: readonly string[], value: TomlValue): void {
  let cursor = root;
  for (const part of path.slice(0, -1)) {
    const current = cursor[part];
    if (!isTable(current)) cursor[part] = {};
    cursor = cursor[part] as TomlTable;
  }
  cursor[path[path.length - 1] ?? ""] = value;
}

function isTable(value: TomlValue | TomlTable | undefined): value is TomlTable {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tomlValue(value: TomlValue | TomlTable | undefined): TomlValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value)) {
    return value;
  }
  return undefined;
}

function formatTomlValue(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map(formatTomlScalar).join(", ")}]`;
  return formatTomlScalar(value);
}

function formatTomlScalar(value: TomlScalar): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = ensureTable(
        root,
        sectionMatch[1]
          ?.split(".")
          .map((part) => part.trim())
          .filter(Boolean) ?? [],
      );
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    current[key] = parseTomlValue(line.slice(eq + 1).trim());
  }

  return root;
}

function ensureTable(root: TomlTable, path: readonly string[]): TomlTable {
  let cursor = root;
  for (const part of path) {
    const current = cursor[part];
    if (!isTable(current)) cursor[part] = {};
    cursor = cursor[part] as TomlTable;
  }
  return cursor;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (ch === quote && !escaped) quote = undefined;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(raw: string): TomlValue {
  if (raw.startsWith("[") && raw.endsWith("]")) return parseTomlArray(raw.slice(1, -1));
  if (raw.startsWith('"') && raw.endsWith('"')) return parseDoubleQuoted(raw);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseTomlArray(raw: string): TomlScalar[] {
  const items: TomlScalar[] = [];
  for (const item of splitTomlArray(raw)) {
    const value = parseTomlValue(item);
    if (Array.isArray(value)) continue;
    items.push(value);
  }
  return items;
}

function splitTomlArray(raw: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (quote === '"' && ch === "\\" && !escaped) {
        escaped = true;
        continue;
      }
      if (ch === quote && !escaped) quote = undefined;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      const item = raw.slice(start, i).trim();
      if (item) out.push(item);
      start = i + 1;
    }
  }
  const last = raw.slice(start).trim();
  if (last) out.push(last);
  return out;
}

function parseDoubleQuoted(raw: string): string {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}
