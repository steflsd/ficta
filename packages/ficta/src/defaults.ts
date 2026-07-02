import { homedir } from "node:os";
import { join } from "node:path";
import { pluginEnvDefaults } from "./plugins/index.js";

const CORE_DEFAULTS = {
  FICTA_REGISTRY_MIN_LEN: "8",
  FICTA_REQUIRE_REGISTRY: "0",
  FICTA_FAIL_CLOSED: "1",
  // Global default for *detector* outages (best-effort detection can't run) — off, so a down backend
  // degrades to no detection rather than blocking. Distinct from FICTA_FAIL_CLOSED (registered-secret
  // leaks, default on). A detector's own [<plugin>] fail_closed overrides this.
  FICTA_FAIL_CLOSED_DETECTION: "0",
  FICTA_REDACT_PATHS: "0",
  FICTA_LOG_MAX_BYTES: String(256 * 1024),
  FICTA_ALLOW_CUSTOM_UPSTREAM: "0",
} as const;

export const FICTA_DEFAULTS = {
  ...pluginEnvDefaults(),
  ...CORE_DEFAULTS,
} as Readonly<Record<string, string>> & typeof CORE_DEFAULTS;

export function defaultLogDir(): string {
  return join(homedir(), ".ficta", "logs");
}

export function applyRuntimeEnvDefaults(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(FICTA_DEFAULTS)) env[key] ??= value;
  env.FICTA_LOG_DIR ??= defaultLogDir();
}
