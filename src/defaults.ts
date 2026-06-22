import { homedir } from "node:os";
import { join } from "node:path";

export const FICTA_DEFAULTS = {
  FICTA_REGISTRY_ENV_FILE_ENABLED: "1",
  FICTA_REGISTRY_ENV_FILE_PATHS: ".env:.env.local",
  FICTA_REGISTRY_DOPPLER_ENABLED: "1",
  FICTA_REGISTRY_DOPPLER_CONFIGS: "current",
  FICTA_REGISTRY_DOPPLER_PROJECT: "",
  FICTA_REGISTRY_DOPPLER_TIMEOUT_MS: "5000",
  FICTA_REGISTRY_PROCESS_ENV_ENABLED: "1",
  FICTA_REGISTRY_PROCESS_ENV_MODE: "secret-ish",
  FICTA_REGISTRY_MIN_LEN: "8",
  FICTA_REQUIRE_REGISTRY: "0",
  FICTA_FAIL_CLOSED: "1",
  FICTA_REDACT_PATHS: "0",
  FICTA_LOG_BODIES: "0",
} as const;

export type FictaDefaultName = keyof typeof FICTA_DEFAULTS;

export function defaultLogDir(): string {
  return join(homedir(), ".ficta", "logs");
}

export function applyRuntimeEnvDefaults(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(FICTA_DEFAULTS)) env[key] ??= value;
  env.FICTA_LOG_DIR ??= defaultLogDir();
}

export function compactUserConfig(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const defaults: Record<string, string> = { ...FICTA_DEFAULTS, FICTA_LOG_DIR: defaultLogDir() };
  for (const [key, value] of Object.entries(values)) {
    if (value === "") continue;
    if (defaults[key] === value) continue;
    out[key] = value;
  }
  return out;
}
