import { randomBytes } from "node:crypto";
import { confirm, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import { compactUserConfig, defaultLogDir, FICTA_DEFAULTS } from "./defaults.js";
import { installShims } from "./install.js";
import { defaultConfigPath, writeUserConfig } from "./user-config.js";

export interface SetupOptions {
  supportedAgents: readonly string[];
}

type RegistrySource = "doppler" | "env-file";
type DopplerConfigMode = "current" | "explicit" | "all";

export async function runSetup(opts: SetupOptions): Promise<void> {
  intro("ficta setup");

  const sources = await promptMultiselect<RegistrySource>(
    "Which registry sources should ficta enable?",
    [
      { value: "doppler", label: "Doppler CLI — load Doppler secrets before the agent starts" },
      { value: "env-file", label: ".env files — load project env files" },
    ],
    defaultSources(),
  );
  const dopplerEnabled = sources.includes("doppler");
  const envFileEnabled = sources.includes("env-file");

  let dopplerConfigMode: DopplerConfigMode = "current";
  let dopplerConfigs = "current";
  let dopplerProject = "";
  if (dopplerEnabled) {
    dopplerConfigMode = await promptSelect<DopplerConfigMode>(
      "Which Doppler configs should ficta preload?",
      [
        { value: "current", label: "current active config only" },
        { value: "explicit", label: "explicit configs, e.g. dev,staging,prod" },
        { value: "all", label: "all configs in the project" },
      ],
      configModeDefault(process.env.FICTA_REGISTRY_DOPPLER_CONFIGS),
    );

    if (dopplerConfigMode === "explicit") {
      dopplerConfigs = await promptText(
        "Doppler configs to preload",
        process.env.FICTA_REGISTRY_DOPPLER_CONFIGS && process.env.FICTA_REGISTRY_DOPPLER_CONFIGS !== "all"
          ? process.env.FICTA_REGISTRY_DOPPLER_CONFIGS
          : "dev,prod",
        "Comma-separated config names. Use project/config for cross-project entries.",
      );
    } else {
      dopplerConfigs = dopplerConfigMode;
    }

    dopplerProject = await promptText(
      "Doppler project override (optional)",
      process.env.FICTA_REGISTRY_DOPPLER_PROJECT ?? "",
      "Leave blank to let the Doppler CLI resolve the active project for this repo.",
      true,
    );
  }

  let envFilePaths = process.env.FICTA_REGISTRY_ENV_FILE_PATHS ?? FICTA_DEFAULTS.FICTA_REGISTRY_ENV_FILE_PATHS;
  if (envFileEnabled) {
    envFilePaths = await promptText(
      "Env files to load",
      envFilePaths,
      "Colon-separated paths, relative to the repo where the agent starts.",
    );
  }

  const minLen = await promptText(
    "Minimum protected value length",
    process.env.FICTA_REGISTRY_MIN_LEN ?? FICTA_DEFAULTS.FICTA_REGISTRY_MIN_LEN,
    "Short values overmatch normal text; 8 is a good default.",
  );

  const hadSurrogateKey = Boolean(process.env.FICTA_SURROGATE_KEY);
  const stableSurrogates = await promptConfirm(
    "Generate a stable local surrogate key? (recommended — keeps surrogates consistent across sessions; stored 0600 in ~/.ficta/config.env, never printed or sent anywhere)",
    true,
  );

  const logBodies = await promptConfirm(
    "Write raw request/response bodies to logs? (debug only; secrets may be written)",
    process.env.FICTA_LOG_BODIES === "1",
  );

  const values: Record<string, string> = {
    FICTA_REGISTRY_DOPPLER_ENABLED: dopplerEnabled ? "1" : "0",
    FICTA_REGISTRY_DOPPLER_CONFIGS: dopplerConfigs,
    FICTA_REGISTRY_DOPPLER_PROJECT: dopplerProject,
    FICTA_REGISTRY_ENV_FILE_ENABLED: envFileEnabled ? "1" : "0",
    FICTA_REGISTRY_ENV_FILE_PATHS: envFilePaths,
    FICTA_REGISTRY_PROCESS_ENV_ENABLED: FICTA_DEFAULTS.FICTA_REGISTRY_PROCESS_ENV_ENABLED,
    FICTA_REGISTRY_PROCESS_ENV_MODE: FICTA_DEFAULTS.FICTA_REGISTRY_PROCESS_ENV_MODE,
    FICTA_REGISTRY_MIN_LEN: minLen,
    FICTA_REQUIRE_REGISTRY: FICTA_DEFAULTS.FICTA_REQUIRE_REGISTRY,
    FICTA_FAIL_CLOSED: FICTA_DEFAULTS.FICTA_FAIL_CLOSED,
    FICTA_LOG_BODIES: logBodies ? "1" : "0",
    FICTA_LOG_DIR: defaultLogDir(),
  };

  if (stableSurrogates) {
    values.FICTA_SURROGATE_KEY = process.env.FICTA_SURROGATE_KEY || randomBytes(32).toString("hex");
  }

  const path = defaultConfigPath();
  writeUserConfig(compactUserConfig(values), path);
  note(path, "Wrote config");
  if (stableSurrogates) {
    note(
      hadSurrogateKey
        ? "kept your existing surrogate key (surrogates stay stable)"
        : "generated a new 256-bit surrogate key — kept local (0600), never printed",
      "Surrogate key",
    );
  }

  const install = await promptConfirm("Install/update claude/codex/pi shims now?", true);
  if (install) {
    const result = installShims({ agents: opts.supportedAgents, force: false, updateShell: true });
    const lines = [
      `shim dir: ${result.shimDir}`,
      `${result.launcher.status} ficta launcher: ${result.launcher.path}`,
      ...result.shims.map((shim) => {
        const suffix = shim.realAgent ? ` (real ${shim.agent}: ${shim.realAgent})` : " (real agent not found yet)";
        return `${shim.status} ${shim.agent}: ${shim.path}${suffix}`;
      }),
    ];
    if (result.rcPath) {
      if (result.pathUpdated) lines.push(`added ${result.shimDir} to PATH in ${result.rcPath}`);
      else if (result.pathAlreadyConfigured) lines.push(`PATH already configured in ${result.rcPath}`);
    }
    note(lines.join("\n"), "Shim install");
  }

  outro("ficta setup complete");
}

async function promptMultiselect<T extends string>(
  message: string,
  options: Array<{ value: T; label: string }>,
  initialValues: T[],
): Promise<T[]> {
  const result = await multiselect<T>({ message, options: options as any, initialValues, required: false });
  if (isCancel(result)) return abortSetup();
  return result as T[];
}

async function promptSelect<T extends string>(
  message: string,
  options: Array<{ value: T; label: string }>,
  initialValue: T,
): Promise<T> {
  const result = await select<T>({ message, options: options as any, initialValue });
  if (isCancel(result)) return abortSetup();
  return result as T;
}

async function promptText(
  message: string,
  initialValue: string,
  placeholder?: string,
  optional = false,
): Promise<string> {
  const result = await text({
    message,
    initialValue,
    placeholder,
    validate(value) {
      if (!optional && !String(value).trim()) return "Enter a value";
      return undefined;
    },
  });
  if (isCancel(result)) return abortSetup();
  return String(result).trim();
}

async function promptConfirm(message: string, initialValue: boolean): Promise<boolean> {
  const result = await confirm({ message, initialValue });
  if (isCancel(result)) return abortSetup();
  return Boolean(result);
}

function defaultSources(): RegistrySource[] {
  const out: RegistrySource[] = [];
  if (enabledDefault("FICTA_REGISTRY_DOPPLER_ENABLED", true)) out.push("doppler");
  if (enabledDefault("FICTA_REGISTRY_ENV_FILE_ENABLED", true)) out.push("env-file");
  return out;
}

function enabledDefault(envName: string, fallback: boolean): boolean {
  const raw = process.env[envName];
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return fallback;
}

function configModeDefault(value: string | undefined): DopplerConfigMode {
  if (value === "all") return "all";
  if (value && value !== "current") return "explicit";
  return "current";
}

function abortSetup(): never {
  outro("setup cancelled");
  process.exit(1);
}
