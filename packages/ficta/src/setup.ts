import { confirm, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import { defaultLogDir, FICTA_DEFAULTS } from "./defaults.js";
import { envFlag, parseBoolean } from "./env-flags.js";
import { installShims } from "./install.js";
import type { RegistrySetupPromptContext, RegistrySetupSource } from "./plugins/index.js";
import { registrySetupDefaults, registrySetupSources, selectedBackendName } from "./plugins/index.js";
import { reviewExcludeNamesInteractively } from "./review.js";
import { configPath, ensureSurrogateKey, readUserConfig, writeUserConfig } from "./user-config.js";

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
          "Registry sources: which sources should ficta use for exact protected values?",
          registrySources.map((source) => ({ value: source.id, label: source.label })),
          registrySources.filter((source) => source.defaultEnabled).map((source) => source.id),
        );

  const registryValues = registrySetupDefaults({ env: process.env });
  for (const source of registrySources) {
    Object.assign(
      registryValues,
      selectedSourceIds.includes(source.id)
        ? await source.enabledValues(registrySourcePromptContext(source, process.env))
        : await source.disabledValues({ env: process.env }),
    );
  }

  // Preview the registry exactly as the chosen sources will load it, then let the user review the
  // discovered names and deselect any that shouldn't be redacted. Direct assignment (not ??=) is
  // deliberate: the review must reflect the values just chosen, overriding any stale shell env. Setup
  // exits when done, so the mutation is process-local; it also busts the plugins' env-keyed caches.
  for (const [key, value] of Object.entries(registryValues)) process.env[key] = value;
  const excludeNames = await reviewExcludeNamesInteractively();

  // Two surfaces, two prompts. This first toggle governs the web/standalone proxy, where redacting PII
  // before the model is a first-class part of the gateway, so default it on; "best-effort" is a caveat
  // on the backend's coverage, not a reason to ship the concept idle.
  // !== "0" means on unless the user explicitly set FICTA_PII_ENABLED=0.
  const piiEnabled = await promptConfirm(
    "PII detection (web / standalone proxy): redact PII before the model and restore it in responses?",
    process.env.FICTA_PII_ENABLED !== "0",
  );

  // Second surface: launched coding agents (claude/codex/pi). Off by default even when the proxy toggle
  // is on, because tokenizing an email inside code you're editing is rarely wanted. Only ask when the
  // proxy toggle is on, since [pii] agents is a no-op without [pii] enabled.
  const piiValues: Record<string, string> = {
    FICTA_PII_ENABLED: piiEnabled ? "1" : "0",
    FICTA_PII_AGENTS: "0",
    FICTA_PII_FAIL_CLOSED: "0",
  };
  if (piiEnabled) {
    const piiAgents = await promptConfirm(
      "PII detection: also redact PII for coding-agent launches (claude/codex/pi)? Off by default.",
      envFlag(process.env.FICTA_PII_AGENTS),
    );
    piiValues.FICTA_PII_AGENTS = piiAgents ? "1" : "0";

    const currentBackend = selectedBackendName(process.env) === "presidio" ? "presidio" : "regex";
    const backend = await promptSelect<"regex" | "presidio">(
      "PII detection: backend",
      [
        { value: "regex", label: "Built-in regex — emails, SSNs, cards; in-process, no dependencies" },
        {
          value: "presidio",
          label: "Microsoft Presidio — names, addresses, orgs, phones (needs a running presidio-analyzer sidecar)",
        },
      ],
      currentBackend,
    );
    piiValues.FICTA_PII_BACKEND = backend;
    if (backend === "presidio") {
      piiValues.FICTA_PII_PRESIDIO_URL = await promptText(
        "PII detection: Presidio analyzer URL",
        process.env.FICTA_PII_PRESIDIO_URL || "http://127.0.0.1:5002",
        "The presidio-analyzer REST endpoint; run it yourself (e.g. via Docker).",
      );
      // Only meaningful for a networked backend (the in-process regex never fails). Default this
      // prompt to Yes: someone who deliberately chose the heavyweight Presidio backend is the user
      // most likely to want its outages enforced, even though the *runtime* default stays fail-open
      // for everyone who never runs setup. An explicit prior choice (shell env or existing config,
      // loaded before setup) still wins; runtime defaults are not applied to env in the setup path,
      // so an unset var reads as undefined → Yes.
      const failClosed = await promptConfirm(
        "PII detection: block requests if Presidio is unreachable? (fail-closed — nothing reaches the model while the sidecar is down; recommended when you rely on Presidio. Choose No to keep forwarding best-effort.)",
        parseBoolean(process.env.FICTA_PII_FAIL_CLOSED) ?? true,
      );
      piiValues.FICTA_PII_FAIL_CLOSED = failClosed ? "1" : "0";
    }
  }

  const values: Record<string, string> = {
    ...registryValues,
    FICTA_REQUIRE_REGISTRY: FICTA_DEFAULTS.FICTA_REQUIRE_REGISTRY,
    FICTA_FAIL_CLOSED: FICTA_DEFAULTS.FICTA_FAIL_CLOSED,
    // Persist the PII toggle + backend as [pii] so redaction is proxy policy, not a per-run flag.
    ...piiValues,
    FICTA_LOG_DIR: defaultLogDir(),
  };

  const path = setupConfigPath();
  const nextConfig = { ...readUserConfig(path), ...values };
  // min_len is no longer prompted (silent default of 8); a hand-set value in the existing config
  // survives via the merge above. Persist the review's exclusion choices: "" clears the key.
  if (excludeNames === "") delete nextConfig.FICTA_REGISTRY_EXCLUDE_NAMES;
  else if (excludeNames !== undefined) nextConfig.FICTA_REGISTRY_EXCLUDE_NAMES = excludeNames;
  writeUserConfig(nextConfig, path);
  note(path, "Wrote config");

  // Stable surrogates are the default, not a choice: every launch runs ensureSurrogateKey anyway
  // (cli.ts), so a "No" here would be undone on the next agent start. Opt-outs that actually hold
  // are FICTA_SURROGATE_KEY (bring your own) and FICTA_CONFIG_FILE=0 (no persistence at all).
  const keyResult = ensureSurrogateKey(path);
  note(
    keyResult.generated
      ? "generated a stable 256-bit surrogate key — kept local (0600), never printed"
      : "stable surrogate key already configured (surrogates stay consistent across sessions)",
    "Surrogate key",
  );

  const install = await promptConfirm("Agent shims: install/update claude/codex/pi shims now?", true);
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

function registrySourcePromptContext(source: RegistrySetupSource, env: NodeJS.ProcessEnv): RegistrySetupPromptContext {
  const prefix = `Registry source "${registrySourceName(source)}"`;
  return {
    env,
    promptSelect<T extends string>(
      message: string,
      options: Array<{ value: T; label: string }>,
      initialValue: T,
    ): Promise<T> {
      return promptSelect(`${prefix}: ${message}`, options, initialValue);
    },
    promptText(message: string, initialValue: string, placeholder?: string, optional?: boolean): Promise<string> {
      return promptText(`${prefix}: ${message}`, initialValue, placeholder, optional);
    },
  };
}

function registrySourceName(source: RegistrySetupSource): string {
  const [name] = source.label.split(" — ");
  return name?.trim() || source.id;
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
