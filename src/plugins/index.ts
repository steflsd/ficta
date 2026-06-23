import { builtInAgentPlugin } from "./agents.js";
import { dopplerPlugin, resetDopplerPluginCacheForTests } from "./doppler.js";
import { knownEnvPlugin, resetKnownEnvPluginCacheForTests } from "./known-env.js";
import type {
  AgentIntegration,
  ConfigBinding,
  ConfigSection,
  FictaPlugin,
  PluginDiscovery,
  PluginDiscoveryStatus,
  ProtectedValue,
  RegistrySetupDiscoveryContext,
  RegistrySetupSource,
  RegistrySourcePlugin,
} from "./types.js";

export {
  builtInAgentPlugin,
  claudeAgent,
  codexAgent,
  codexPersistedFictaCleanupOverrides,
  codexUsesChatgptAuth,
  piAgent,
  piProviderExtension,
} from "./agents.js";
export { dopplerPlugin, loadDopplerStats, resetDopplerPluginCacheForTests } from "./doppler.js";
export { knownEnvPlugin, loadKnownEnvStats, resetKnownEnvPluginCacheForTests } from "./known-env.js";
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
  FictaPlugin,
  PluginDiscovery,
  PluginDiscoveryStatus,
  ProtectedValue,
  ProtectedValueKind,
  ProtectionConfidence,
  RegistryPluginConfig,
  RegistryPluginSetup,
  RegistrySetupDiscoveryContext,
  RegistrySetupPromptContext,
  RegistrySetupSource,
  RegistrySourcePlugin,
} from "./types.js";

export const defaultPlugins: readonly FictaPlugin[] = [dopplerPlugin, knownEnvPlugin, builtInAgentPlugin];

export function pluginConfigBindings(plugins: readonly FictaPlugin[] = defaultPlugins): ConfigBinding[] {
  return registryPlugins(plugins).flatMap((plugin) => [...plugin.config.bindings]);
}

export function pluginConfigSections(plugins: readonly FictaPlugin[] = defaultPlugins): ConfigSection[] {
  return registryPlugins(plugins).flatMap((plugin) => [...plugin.config.sections]);
}

export function pluginEnvDefaults(plugins: readonly FictaPlugin[] = defaultPlugins): Record<string, string> {
  const out: Record<string, string> = {};
  for (const plugin of registryPlugins(plugins)) Object.assign(out, plugin.config.envDefaults);
  return out;
}

export function registrySetupDefaults(
  ctx: RegistrySetupDiscoveryContext = { env: process.env },
  plugins: readonly FictaPlugin[] = defaultPlugins,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const plugin of registryPlugins(plugins)) Object.assign(out, plugin.setup.registryDefaults?.(ctx) ?? {});
  return out;
}

export function registrySetupSources(
  ctx: RegistrySetupDiscoveryContext = { env: process.env },
  plugins: readonly FictaPlugin[] = defaultPlugins,
): RegistrySetupSource[] {
  return registryPlugins(plugins).flatMap((plugin) => [...plugin.setup.registrySources(ctx)]);
}

export function validatePluginBoundaries(plugins: readonly FictaPlugin[]): void {
  for (const rawPlugin of plugins as unknown as readonly Record<string, unknown>[]) {
    const name = typeof rawPlugin.name === "string" ? rawPlugin.name : "<unnamed>";
    const hasRegistryHook =
      "loadValues" in rawPlugin || "discover" in rawPlugin || "config" in rawPlugin || "setup" in rawPlugin;

    if (rawPlugin.kind !== "registry-source") {
      if (hasRegistryHook) {
        throw new Error(`ficta plugin ${name} declares registry-source hooks but is not kind="registry-source"`);
      }
      if (rawPlugin.kind !== "detector" && rawPlugin.kind !== "agent-integration") {
        throw new Error(`ficta plugin ${name} has unknown kind ${String(rawPlugin.kind)}`);
      }
      continue;
    }

    if (typeof rawPlugin.loadValues !== "function") {
      throw new Error(`registry-source plugin ${name} must implement loadValues()`);
    }
    if (typeof rawPlugin.discover !== "function") {
      throw new Error(`registry-source plugin ${name} must implement discover()`);
    }
    if (!isRecord(rawPlugin.config)) {
      throw new Error(`registry-source plugin ${name} must define config metadata`);
    }
    if (!Array.isArray(rawPlugin.config.bindings)) {
      throw new Error(`registry-source plugin ${name} config.bindings must be an array`);
    }
    if (!Array.isArray(rawPlugin.config.sections)) {
      throw new Error(`registry-source plugin ${name} config.sections must be an array`);
    }
    if (!isRecord(rawPlugin.config.envDefaults)) {
      throw new Error(`registry-source plugin ${name} config.envDefaults must be an object`);
    }
    if (!isRecord(rawPlugin.setup) || typeof rawPlugin.setup.registrySources !== "function") {
      throw new Error(`registry-source plugin ${name} must define setup.registrySources()`);
    }
  }
}

function registryPlugins(plugins: readonly FictaPlugin[]): RegistrySourcePlugin[] {
  validatePluginBoundaries(plugins);
  return plugins.filter((plugin): plugin is RegistrySourcePlugin => plugin.kind === "registry-source");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface PluginRegistrySnapshot {
  values: ProtectedValue[];
  pluginNames: string[];
  discoveries: PluginDiscovery[];
}

export function loadPluginRegistry(plugins: readonly FictaPlugin[] = defaultPlugins): PluginRegistrySnapshot {
  validatePluginBoundaries(plugins);

  const values: ProtectedValue[] = [];
  const pluginNames: string[] = [];
  const discoveries: PluginDiscovery[] = [];

  for (const plugin of plugins) {
    pluginNames.push(plugin.name);
    if (plugin.kind !== "registry-source") continue;

    try {
      const loaded = plugin.loadValues();
      for (const value of loaded) {
        values.push({ ...value, plugin: value.plugin ?? plugin.name });
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

    try {
      discoveries.push(...plugin.discover());
    } catch {
      discoveries.push({
        id: `${plugin.name}/discover`,
        plugin: plugin.name,
        label: plugin.name,
        status: "error",
        message: "plugin threw while discovering sources",
      });
    }
  }

  return { values, pluginNames, discoveries };
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

export function pluginsHaveDetectors(plugins: readonly FictaPlugin[]): boolean {
  validatePluginBoundaries(plugins);
  return plugins.some((plugin) => Boolean(plugin.detectText));
}

export function resetPluginCachesForTests(): void {
  resetDopplerPluginCacheForTests();
  resetKnownEnvPluginCacheForTests();
}

export function registryDiscoveryLines(discoveries: readonly PluginDiscovery[], indent = "  "): string[] {
  if (discoveries.length === 0) return [`${indent}- no registry sources reported`];

  const out: string[] = [];
  for (const d of discoveries) {
    const count = d.valueCount === undefined ? "" : ` (${d.valueCount} ${plural(d.valueCount, "value")})`;
    const message = d.message ? ` — ${d.message}` : "";
    out.push(`${indent}${statusIcon(d.status)} ${d.label}${count}${message}`);
    for (const detail of d.details?.slice(0, 6) ?? []) out.push(`${indent}    ${detail}`);
    if ((d.details?.length ?? 0) > 6) out.push(`${indent}    … ${(d.details?.length ?? 0) - 6} more`);
  }
  return out;
}

function statusIcon(status: PluginDiscoveryStatus): string {
  switch (status) {
    case "loaded":
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

function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}
