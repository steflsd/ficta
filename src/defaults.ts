import { homedir } from "node:os";
import { join } from "node:path";
import { pluginEnvDefaults } from "./plugins/index.js";

const CORE_DEFAULTS = {
  FICTA_REGISTRY_MIN_LEN: "8",
  FICTA_REQUIRE_REGISTRY: "0",
  FICTA_FAIL_CLOSED: "1",
  FICTA_REDACT_PATHS: "0",
  FICTA_LOG_BODIES: "0",
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
