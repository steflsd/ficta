import { isRecord } from "../vault.js";
import type {
  EffectiveRegistryExclusionRule,
  FictaPlugin,
  ProtectedValue,
  RegistryExclusionRule,
  RegistryPolicy,
  RegistryPolicyContribution,
} from "./types.js";

const EMPTY_REGISTRY_POLICY: RegistryPolicy = Object.freeze({ exclusions: Object.freeze([]) });

/**
 * Build the effective registry policy from plugin-declared domain facts. Plugins declare only safe
 * metadata identifiers (for now, exact env var names) describing which of their own domain's names
 * are not secret material.
 *
 * Registry exclusion is an *un-protection* capability: it removes candidates that would otherwise be
 * protected. That is the inverse of the normal plugin contract (plugins may only add protection), so
 * exclusions are honored only when declared by a trusted plugin. `trusted` is the (required) set of
 * plugins core vouches for (the built-ins); rules from any other plugin are recorded with
 * `trusted: false` so they can be reported, but core never enforces them. It is required rather than
 * defaulted so callers cannot accidentally grant enforcement to every plugin.
 *
 * Expects plugins already validated by `validatePluginBoundaries` (which `loadPluginRegistry` calls
 * immediately before this); it does not re-validate.
 */
export function buildRegistryPolicy(
  plugins: readonly FictaPlugin[],
  trusted: ReadonlySet<FictaPlugin>,
): RegistryPolicy {
  const exclusions: EffectiveRegistryExclusionRule[] = [];
  const seen = new Set<string>();

  for (const plugin of plugins) {
    for (const rule of plugin.registryPolicy?.exclusions ?? []) {
      const key = exclusionKey(plugin.name, rule);
      if (seen.has(key)) continue;
      seen.add(key);
      exclusions.push({ ...rule, plugin: plugin.name, trusted: trusted.has(plugin) });
    }
  }

  exclusions.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.id.localeCompare(b.id));
  return exclusions.length === 0 ? EMPTY_REGISTRY_POLICY : { exclusions };
}

/**
 * Return the exact policy rule that excludes a candidate, if any. Matches on safe metadata
 * identifiers only (never on the raw value). Only trusted rules are enforced unless
 * `includeUntrusted` is set (used by diagnostics, never on the protection path).
 */
export function protectedValueExcludedBy(
  value: Pick<ProtectedValue, "name">,
  policy: RegistryPolicy = EMPTY_REGISTRY_POLICY,
  opts: { includeUntrusted?: boolean } = {},
): EffectiveRegistryExclusionRule | undefined {
  for (const rule of policy.exclusions) {
    if (!rule.trusted && !opts.includeUntrusted) continue;
    if (rule.kind !== "env-name") continue;
    if (rule.names.includes(value.name)) return rule;
  }
  return undefined;
}

/** Synthetic plugin label for the user's own exclusion list (registry.exclude_names / ficta review). */
export const USER_EXCLUSION_PLUGIN = "user-config";
export const USER_EXCLUSION_RULE_ID = "user-exclude-names";

export interface UserExclusionParse {
  /** Enforced rule built from the valid names, or undefined when none are valid. */
  rule?: EffectiveRegistryExclusionRule;
  /** Entries that failed env-name validation — reported for diagnostics, never enforced. */
  invalidNames: string[];
}

/**
 * Parse the user's own exclusion list (comma-separated env var names from FICTA_REGISTRY_EXCLUDE_NAMES
 * / [registry] exclude_names) into an enforced, trusted rule. This is the one un-protection channel
 * the local user controls directly; it is gated by the 0600 config file / process env, so core trusts
 * it like a built-in. Invalid entries are separated out rather than silently dropped.
 */
export function parseUserExclusionRule(raw: string | undefined): UserExclusionParse {
  const seen = new Set<string>();
  const names: string[] = [];
  const invalidNames: string[] = [];
  for (const entry of (raw ?? "").split(",")) {
    const name = entry.trim();
    if (!name) continue;
    if (!ENV_NAME_RE.test(name)) {
      if (!invalidNames.includes(name)) invalidNames.push(name);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  names.sort();
  const rule =
    names.length === 0
      ? undefined
      : {
          id: USER_EXCLUSION_RULE_ID,
          kind: "env-name" as const,
          names,
          reason: "excluded by user (ficta review / registry.exclude_names)",
          plugin: USER_EXCLUSION_PLUGIN,
          trusted: true,
        };
  return { rule, invalidNames };
}

export function validateRegistryPolicy(pluginName: string, value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`ficta plugin ${pluginName} registryPolicy must be an object`);
  assertOnlyKeys(value, ["exclusions"], `ficta plugin ${pluginName} registryPolicy`);

  const policy = value as RegistryPolicyContribution;
  if (policy.exclusions === undefined) return;
  if (!Array.isArray(policy.exclusions)) {
    throw new Error(`ficta plugin ${pluginName} registryPolicy.exclusions must be an array`);
  }

  for (const [index, rule] of policy.exclusions.entries()) {
    const label = `ficta plugin ${pluginName} registryPolicy.exclusions[${index}]`;
    if (!isRecord(rule)) throw new Error(`${label} must be an object`);
    assertOnlyKeys(rule, ["id", "kind", "names", "reason"], label);
    if (typeof rule.id !== "string" || !rule.id) throw new Error(`${label}.id must be a non-empty string`);
    if (rule.kind !== "env-name") throw new Error(`${label}.kind must be "env-name"`);
    if (!Array.isArray(rule.names) || rule.names.length === 0) {
      throw new Error(`${label}.names must be a non-empty array`);
    }
    const seenNames = new Set<string>();
    for (const name of rule.names) {
      if (typeof name !== "string" || !ENV_NAME_RE.test(name)) {
        throw new Error(`${label}.names must contain exact env var names only`);
      }
      if (seenNames.has(name)) throw new Error(`${label}.names must not contain duplicates`);
      seenNames.add(name);
    }
    if (typeof rule.reason !== "string" || !rule.reason.trim()) {
      throw new Error(`${label}.reason must be a non-empty string`);
    }
  }
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field(s): ${unknown.join(", ")}`);
  }
}

function exclusionKey(pluginName: string, rule: RegistryExclusionRule): string {
  return `${pluginName}\0${rule.id}\0${rule.kind}\0${[...rule.names].sort().join("\0")}`;
}
