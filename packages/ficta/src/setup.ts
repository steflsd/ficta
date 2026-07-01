import { randomBytes } from "node:crypto";
import { confirm, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import { defaultLogDir, FICTA_DEFAULTS } from "./defaults.js";
import { installShims } from "./install.js";
import { registrySetupDefaults, registrySetupSources } from "./plugins/index.js";
import { configPath, readUserConfig, writeUserConfig } from "./user-config.js";

export interface SetupOptions {
  supportedAgents: readonly string[];
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  intro("ficta setup");

  const registrySources = registrySetupSources({ env: process.env });
  const selectedSourceIds =
    registrySources.length === 0
      ? []
      : await promptMultiselect<string>(
          "Which registry sources should ficta enable?",
          registrySources.map((source) => ({ value: source.id, label: source.label })),
          registrySources.filter((source) => source.defaultEnabled).map((source) => source.id),
        );

  const registryValues = registrySetupDefaults({ env: process.env });
  const setupPromptContext = { env: process.env, promptSelect, promptText };
  for (const source of registrySources) {
    Object.assign(
      registryValues,
      selectedSourceIds.includes(source.id)
        ? await source.enabledValues(setupPromptContext)
        : await source.disabledValues({ env: process.env }),
    );
  }

  const minLen = await promptText(
    "Minimum protected value length",
    process.env.FICTA_REGISTRY_MIN_LEN ?? FICTA_DEFAULTS.FICTA_REGISTRY_MIN_LEN,
    "Short values overmatch normal text; 8 is a good default.",
  );

  const hadSurrogateKey = Boolean(process.env.FICTA_SURROGATE_KEY);
  const stableSurrogates = await promptConfirm(
    "Generate a stable local surrogate key? (recommended — keeps surrogates consistent across sessions; stored 0600 in ~/.ficta/config.toml, never printed or sent anywhere)",
    true,
  );

  const logBodies = await promptConfirm(
    "Write raw request/response bodies to logs? (debug only; secrets may be written)",
    process.env.FICTA_LOG_BODIES === "1",
  );

  const values: Record<string, string> = {
    ...registryValues,
    FICTA_REGISTRY_MIN_LEN: minLen,
    FICTA_REQUIRE_REGISTRY: FICTA_DEFAULTS.FICTA_REQUIRE_REGISTRY,
    FICTA_FAIL_CLOSED: FICTA_DEFAULTS.FICTA_FAIL_CLOSED,
    FICTA_LOG_BODIES: logBodies ? "1" : "0",
    FICTA_LOG_DIR: defaultLogDir(),
  };

  if (stableSurrogates) {
    values.FICTA_SURROGATE_KEY = process.env.FICTA_SURROGATE_KEY || randomBytes(32).toString("hex");
  }

  const path = setupConfigPath();
  const nextConfig = { ...readUserConfig(path), ...values };
  if (!stableSurrogates) delete nextConfig.FICTA_SURROGATE_KEY;
  writeUserConfig(nextConfig, path);
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
    const lines = [`shim dir: ${result.shimDir}`, `${result.launcher.status} ficta launcher: ${result.launcher.path}`];
    lines.push(
      ...result.shims.map((shim) => {
        const suffix = shim.realAgent ? ` (real ${shim.agent}: ${shim.realAgent})` : " (real agent not found yet)";
        return `${shim.status} ${shim.agent}: ${shim.path}${suffix}`;
      }),
    );
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

function setupConfigPath(): string {
  const path = configPath();
  if (path) return path;
  note(
    "FICTA_CONFIG_FILE=0 disables persistent config loading. Unset it, or set FICTA_CONFIG_FILE=/path/to/config.toml, then rerun setup.",
    "No config file target",
  );
  outro("setup cancelled");
  process.exit(2);
}

function abortSetup(): never {
  outro("setup cancelled");
  process.exit(1);
}
