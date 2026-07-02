import { plural } from "../text.js";
import { isRecord } from "../vault.js";
import { builtInAgentPlugin } from "./agents.js";
import { dopplerPlugin, resetDopplerPluginCacheForTests } from "./doppler.js";
import { knownEnvPlugin, resetKnownEnvPluginCacheForTests } from "./known-env.js";
import { piiPlugin, resetPiiRecognizerStateForTests } from "./pii/index.js";
import {
  buildRegistryPolicy,
  parseUserExclusionRule,
  protectedValueExcludedBy,
  USER_EXCLUSION_PLUGIN,
  validateRegistryPolicy,
} from "./policy.js";
import type {
  AgentIntegration,
  ConfigBinding,
  ConfigSection,
  EffectiveRegistryExclusionRule,
  FictaPlugin,
  PluginDiscovery,
  PluginDiscoveryStatus,
  ProtectedValue,
  RegistryPluginConfig,
  RegistryPluginSetup,
  RegistryPolicy,
  RegistrySetupDiscoveryContext,
  RegistrySetupSource,
} from "./types.js";

export {
  claudeAgent,
  codexAgent,
  codexPersistedFictaCleanupOverrides,
  piAgent,
  piModelsConfig,
} from "./agents.js";
export { dopplerPlugin } from "./doppler.js";
export {
  piiEnabled,
  piiFailClosed,
  piiPlugin,
  resetPiiRecognizerStateForTests,
  resolveAgentPiiEnabled,
} from "./pii/index.js";
export {
  checkPresidioHealth,
  PresidioUnavailableError,
  presidioConfig,
} from "./pii/presidio-recognizer.js";
export type { PiiRecognizer } from "./pii/recognizer.js";
export {
  activeBackend,
  builtInBackendNames,
  DEFAULT_BACKEND,
  ENV_BACKEND,
  selectedBackendName,
} from "./pii/registry.js";
export type { UserExclusionParse } from "./policy.js";
export {
  buildRegistryPolicy,
  parseUserExclusionRule,
  protectedValueExcludedBy,
  USER_EXCLUSION_PLUGIN,
  USER_EXCLUSION_RULE_ID,
} from "./policy.js";
export type {
  AgentBypassContext,
  AgentIntegration,
  AgentIntegrationPlugin,
  AgentLaunchContext,
  AgentLaunchPlan,
  ConfigBinding,
  ConfigBindingKind,
  ConfigSection,
  DetectorPlugin,
  DetectTextContext,
  EffectiveRegistryExclusionRule,
  FictaPlugin,
  PluginDiscovery,
  PluginDiscoveryStatus,
  ProtectedValue,
  ProtectedValueKind,
  ProtectionConfidence,
  RegistryExclusionKind,
  RegistryExclusionRule,
  RegistryPluginConfig,
  RegistryPluginSetup,
  RegistryPolicy,
  RegistryPolicyContribution,
  RegistrySetupDiscoveryContext,
  RegistrySetupPromptContext,
  RegistrySetupSource,
  RegistrySourcePlugin,
} from "./types.js";

export const defaultPlugins: readonly FictaPlugin[] = [dopplerPlugin, knownEnvPlugin, piiPlugin, builtInAgentPlugin];

/**
 * Plugins core vouches for. Only these may contribute *enforced* registry exclusions
 * (un-protection). Identity-based so a fixture/external plugin cannot grant itself trust by name.
 */
const TRUSTED_PLUGINS: ReadonlySet<FictaPlugin> = new Set(defaultPlugins);

export function pluginConfigBindings(plugins: readonly FictaPlugin[] = defaultPlugins): ConfigBinding[] {
  return collectPluginConfigs(plugins).flatMap((config) => [...config.bindings]);
}

export function pluginConfigSections(plugins: readonly FictaPlugin[] = defaultPlugins): ConfigSection[] {
  return collectPluginConfigs(plugins).flatMap((config) => [...config.sections]);
}

export function pluginEnvDefaults(plugins: readonly FictaPlugin[] = defaultPlugins): Record<string, string> {
  const out: Record<string, string> = {};
  for (const config of collectPluginConfigs(plugins)) Object.assign(out, config.envDefaults);
  return out;
}

export function registrySetupDefaults(
  ctx: RegistrySetupDiscoveryContext = { env: process.env },
  plugins: readonly FictaPlugin[] = defaultPlugins,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const setup of collectPluginSetups(plugins)) Object.assign(out, setup.registryDefaults?.(ctx) ?? {});
  return out;
}

export function registrySetupSources(
  ctx: RegistrySetupDiscoveryContext = { env: process.env },
  plugins: readonly FictaPlugin[] = defaultPlugins,
): RegistrySetupSource[] {
  return collectPluginSetups(plugins).flatMap((setup) => [...setup.registrySources(ctx)]);
}

export function validatePluginBoundaries(plugins: readonly FictaPlugin[]): void {
  for (const rawPlugin of plugins as unknown as readonly Record<string, unknown>[]) {
    const name = typeof rawPlugin.name === "string" ? rawPlugin.name : "<unnamed>";
    validateRegistryPolicy(name, rawPlugin.registryPolicy);

    // loadValues is the registry-source-defining capability; no other kind may declare it.
    if (rawPlugin.kind !== "registry-source" && "loadValues" in rawPlugin) {
      throw new Error(`ficta plugin ${name} declares registry-source hooks but is not kind="registry-source"`);
    }

    if (rawPlugin.kind === "detector") {
      if (typeof rawPlugin.detectText !== "function") {
        throw new Error(`detector plugin ${name} must implement detectText()`);
      }
      // config/setup/discover are optional for a detector — validate shape only when declared.
      if ("config" in rawPlugin) validatePluginConfigShape(name, rawPlugin.config);
      if (
        "setup" in rawPlugin &&
        (!isRecord(rawPlugin.setup) || typeof rawPlugin.setup.registrySources !== "function")
      ) {
        throw new Error(`detector plugin ${name} must define setup.registrySources() when it declares setup`);
      }
      if ("discover" in rawPlugin && typeof rawPlugin.discover !== "function") {
        throw new Error(`detector plugin ${name} discover must be a function`);
      }
      continue;
    }

    if (rawPlugin.kind === "agent-integration") {
      // Agent integrations carry only `agents`; config/setup/discover belong to other kinds.
      if ("config" in rawPlugin || "setup" in rawPlugin || "discover" in rawPlugin) {
        throw new Error(`ficta plugin ${name} declares registry-source hooks but is not kind="registry-source"`);
      }
      continue;
    }

    if (rawPlugin.kind !== "registry-source") {
      throw new Error(`ficta plugin ${name} has unknown kind ${String(rawPlugin.kind)}`);
    }

    if (typeof rawPlugin.loadValues !== "function") {
      throw new Error(`registry-source plugin ${name} must implement loadValues()`);
    }
    if (typeof rawPlugin.discover !== "function") {
      throw new Error(`registry-source plugin ${name} must implement discover()`);
    }
    validatePluginConfigShape(name, rawPlugin.config);
    if (!isRecord(rawPlugin.setup) || typeof rawPlugin.setup.registrySources !== "function") {
      throw new Error(`registry-source plugin ${name} must define setup.registrySources()`);
    }
  }
}

/** Shared shape check for a plugin's `config` metadata (registry-source required, detector optional). */
function validatePluginConfigShape(name: string, config: unknown): void {
  if (!isRecord(config)) {
    throw new Error(`plugin ${name} must define config metadata`);
  }
  if (!Array.isArray(config.bindings)) {
    throw new Error(`plugin ${name} config.bindings must be an array`);
  }
  if (!Array.isArray(config.sections)) {
    throw new Error(`plugin ${name} config.sections must be an array`);
  }
  if (!isRecord(config.envDefaults)) {
    throw new Error(`plugin ${name} config.envDefaults must be an object`);
  }
}

/** Config metadata declared by any plugin kind (registry-source always; detector optionally). */
function collectPluginConfigs(plugins: readonly FictaPlugin[]): RegistryPluginConfig[] {
  validatePluginBoundaries(plugins);
  return plugins.map((plugin) => plugin.config).filter((config): config is RegistryPluginConfig => isRecord(config));
}

/** Setup metadata declared by any plugin kind (registry-source always; detector optionally). */
function collectPluginSetups(plugins: readonly FictaPlugin[]): RegistryPluginSetup[] {
  validatePluginBoundaries(plugins);
  return plugins.map((plugin) => plugin.setup).filter((setup): setup is RegistryPluginSetup => isRecord(setup));
}

export interface PluginRegistrySnapshot {
  values: ProtectedValue[];
  pluginNames: string[];
  discoveries: PluginDiscovery[];
  registryPolicy: RegistryPolicy;
  /** Count of launch-time candidates dropped by an enforced (trusted) exclusion. */
  policyExcluded: number;
  /** Excluded counts keyed by the candidate's `source` (e.g. "process-env"), for per-source reporting. */
  policyExcludedBySource: Record<string, number>;
  /** Safe metadata for each dropped candidate — names/sources/rule only, never values (used by `ficta review`). */
  policyExcludedValues: Array<{ name: string; source: string; plugin: string; rule: EffectiveRegistryExclusionRule }>;
}

export function loadPluginRegistry(plugins: readonly FictaPlugin[] = defaultPlugins): PluginRegistrySnapshot {
  validatePluginBoundaries(plugins);

  // The user's own exclusion list is a trusted rule (see parseUserExclusionRule); prepend it so an
  // overlapping name is attributed to the user rather than a plugin. It flows through the returned
  // registryPolicy to both enforcement seams (load filter here + request-time admit() in engine.ts).
  const userExclusion = parseUserExclusionRule(process.env.FICTA_REGISTRY_EXCLUDE_NAMES);
  const pluginPolicy = buildRegistryPolicy(plugins, TRUSTED_PLUGINS);
  const registryPolicy: RegistryPolicy = userExclusion.rule
    ? { exclusions: [userExclusion.rule, ...pluginPolicy.exclusions] }
    : pluginPolicy;
  const values: ProtectedValue[] = [];
  const pluginNames: string[] = [];
  const discoveries: PluginDiscovery[] = [];
  let policyExcluded = 0;
  const policyExcludedBySource: Record<string, number> = {};
  const policyExcludedValues: PluginRegistrySnapshot["policyExcludedValues"] = [];

  if (userExclusion.invalidNames.length > 0) {
    // status "available" renders as a note without tripping strict-mode error gates (which key off "error").
    discoveries.push({
      id: "user-config/exclude-names",
      plugin: USER_EXCLUSION_PLUGIN,
      label: "registry.exclude_names",
      status: "available",
      message: `ignoring invalid name(s): ${userExclusion.invalidNames.join(", ")}`,
    });
  }

  for (const plugin of plugins) {
    pluginNames.push(plugin.name);

    if (plugin.kind !== "registry-source") {
      // A non-registry plugin (e.g. a config-driven detector) contributes no exact values at load
      // time, but may still report a discovery/status line for the startup banner.
      if (plugin.discover) collectDiscovery(plugin.name, plugin.discover, discoveries);
      continue;
    }

    try {
      const loaded = plugin.loadValues();
      for (const value of loaded) {
        const candidate = { ...value, plugin: value.plugin ?? plugin.name };
        const excludedBy = protectedValueExcludedBy(candidate, registryPolicy);
        if (excludedBy) {
          policyExcluded++;
          policyExcludedBySource[candidate.source] = (policyExcludedBySource[candidate.source] ?? 0) + 1;
          policyExcludedValues.push({
            name: candidate.name,
            source: candidate.source,
            plugin: candidate.plugin,
            rule: excludedBy,
          });
          continue;
        }
        values.push(candidate);
      }
    } catch {
      discoveries.push({
        id: `${plugin.name}/load`,
        plugin: plugin.name,
        label: plugin.name,
        status: "error",
        message: "plugin threw while loading values",
      });
      continue;
    }

    collectDiscovery(plugin.name, plugin.discover, discoveries);
  }

  return {
    values,
    pluginNames,
    discoveries,
    registryPolicy,
    policyExcluded,
    policyExcludedBySource,
    policyExcludedValues,
  };
}

/** Run a plugin's discover() and append its lines, turning a throw into a safe error discovery. */
function collectDiscovery(
  name: string,
  discover: () => readonly PluginDiscovery[],
  discoveries: PluginDiscovery[],
): void {
  try {
    discoveries.push(...discover());
  } catch {
    discoveries.push({
      id: `${name}/discover`,
      plugin: name,
      label: name,
      status: "error",
      message: "plugin threw while discovering sources",
    });
  }
}

/**
 * Resolve a discovery to the `ProtectedValue.source` key its values carry, so per-source exclusion
 * counts (keyed by source) can be attributed back to a discovery line. The id/source naming is not
 * uniform across built-ins (Doppler's id is `doppler-cli/secrets-download` but its source is
 * `doppler`), so this small lookup is the single place that bridges the two.
 */
export function discoverySourceKey(discovery: PluginDiscovery): string | undefined {
  if (discovery.id.endsWith("/process-env")) return "process-env";
  if (discovery.id.endsWith("/env-file")) return "env-file";
  if (discovery.plugin === "doppler-cli") return "doppler";
  return undefined;
}

/** Safe one-line summaries of registry-policy exclusions, for verbose reports. */
export function registryPolicyLines(
  policy: RegistryPolicy,
  indent = "  ",
  opts: { enforcedOnly?: boolean } = {},
): string[] {
  const rules = opts.enforcedOnly ? policy.exclusions.filter((rule) => rule.trusted) : policy.exclusions;
  if (rules.length === 0) return [];
  const out: string[] = [];
  for (const rule of rules) {
    const state = rule.trusted ? "enforced" : "declared, not enforced (untrusted plugin)";
    out.push(
      `${indent}${rule.trusted ? "✓" : "!"} ${rule.plugin}: ${rule.names.join(", ")} — ${rule.reason} [${state}]`,
    );
  }
  return out;
}

export function loadRegistryValues(plugins: readonly FictaPlugin[] = defaultPlugins): ProtectedValue[] {
  return loadPluginRegistry(plugins).values;
}

export function agentIntegrations(plugins: readonly FictaPlugin[] = defaultPlugins): AgentIntegration[] {
  validatePluginBoundaries(plugins);
  return plugins.flatMap((plugin) => plugin.agents ?? []);
}

export function agentCommands(plugins: readonly FictaPlugin[] = defaultPlugins): string[] {
  return agentIntegrations(plugins).map((agent) => agent.command);
}

export function findAgentIntegration(
  command: string,
  plugins: readonly FictaPlugin[] = defaultPlugins,
): AgentIntegration | undefined {
  return agentIntegrations(plugins).find((agent) => agent.command === command);
}

export function resetPluginCachesForTests(): void {
  resetDopplerPluginCacheForTests();
  resetKnownEnvPluginCacheForTests();
  resetPiiRecognizerStateForTests();
}

export function registryDiscoveryLines(
  discoveries: readonly PluginDiscovery[],
  indent = "  ",
  excludedBySource: Record<string, number> = {},
): string[] {
  if (discoveries.length === 0) return [`${indent}- no registry sources reported`];

  const out: string[] = [];
  for (const d of discoveries) {
    const count = d.valueCount === undefined ? "" : ` (${d.valueCount} ${plural(d.valueCount, "value")})`;
    const excluded = excludedBySource[discoverySourceKey(d) ?? ""] ?? 0;
    const excludedNote = excluded > 0 ? ` (${excluded} excluded by policy)` : "";
    const message = d.message ? ` — ${d.message}` : "";
    out.push(`${indent}${statusIcon(d.status)} ${d.label}${count}${excludedNote}${message}`);
    for (const detail of d.details?.slice(0, 6) ?? []) out.push(`${indent}    ${detail}`);
    if ((d.details?.length ?? 0) > 6) out.push(`${indent}    … ${(d.details?.length ?? 0) - 6} more`);
  }
  return out;
}

function statusIcon(status: PluginDiscoveryStatus): string {
  switch (status) {
    case "loaded":
      return "✓";
    case "active":
      return "✓";
    case "available":
      return "!";
    case "error":
      return "✗";
    case "disabled":
    case "not_found":
      return "-";
  }
}
