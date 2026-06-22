import { builtInAgentPlugin } from "./agents.js";
import { dopplerPlugin, resetDopplerPluginCacheForTests } from "./doppler.js";
import { knownEnvPlugin, resetKnownEnvPluginCacheForTests } from "./known-env.js";
import type { AgentIntegration, FictaPlugin, PluginDiscovery, PluginDiscoveryStatus, ProtectedValue } from "./types.js";

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
  AgentLaunchContext,
  AgentLaunchPlan,
  DetectTextContext,
  FictaPlugin,
  PluginDiscovery,
  PluginDiscoveryStatus,
  ProtectedValue,
  ProtectedValueKind,
  ProtectionConfidence,
} from "./types.js";

export const defaultPlugins: readonly FictaPlugin[] = [dopplerPlugin, knownEnvPlugin, builtInAgentPlugin];

export interface PluginRegistrySnapshot {
  values: ProtectedValue[];
  pluginNames: string[];
  discoveries: PluginDiscovery[];
}

export function loadPluginRegistry(plugins: readonly FictaPlugin[] = defaultPlugins): PluginRegistrySnapshot {
  const values: ProtectedValue[] = [];
  const pluginNames: string[] = [];
  const discoveries: PluginDiscovery[] = [];

  for (const plugin of plugins) {
    pluginNames.push(plugin.name);

    try {
      const loaded = plugin.loadValues?.() ?? [];
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
      discoveries.push(...(plugin.discover?.() ?? []));
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
