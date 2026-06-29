import {
  type DetectTextContext,
  defaultPlugins,
  type FictaPlugin,
  loadPluginRegistry,
  type PluginRegistrySnapshot,
  type ProtectedValue,
  protectedValueExcludedBy,
  type RegistryPolicy,
} from "./plugins/index.js";
import { Vault } from "./vault.js";
import type { Wire } from "./wire.js";
import { sseRestoreAdapterFor } from "./wire-restore.js";

export interface ProtectionEngineOptions {
  plugins?: readonly FictaPlugin[];
  values?: readonly ProtectedValue[];
}

export interface BodyRedactionResult {
  body: string;
  count: number;
  leaks: number;
}

export interface TextRedactionResult {
  text: string;
  count: number;
  leaks: number;
}

/**
 * Security-critical orchestration layer. Plugins can only add values; the vault does the actual
 * replacement/restore/leak check. That keeps the core invariant testable and plugin-agnostic.
 */
export class ProtectionEngine {
  private readonly plugins: readonly FictaPlugin[];
  private readonly hasDetectors: boolean;
  private readonly vault: Vault;
  private readonly policy: RegistryPolicy;

  /** Safe launch-time snapshot of registry-source discovery. */
  readonly registry: PluginRegistrySnapshot;

  /** Number of values loaded at construction time from exact-registry plugins. */
  readonly registrySize: number;

  constructor(opts: ProtectionEngineOptions = {}) {
    this.plugins = opts.plugins ?? defaultPlugins;
    this.registry = loadPluginRegistry(this.plugins);
    // loadPluginRegistry already ran validatePluginBoundaries, so derive this directly rather than
    // calling pluginsHaveDetectors (which would re-validate every plugin).
    this.hasDetectors = this.plugins.some((plugin) => Boolean(plugin.detectText));
    this.policy = this.registry.registryPolicy;
    // registry.values are already policy-filtered by loadPluginRegistry; caller-supplied opts.values
    // pass through the same enforced exclusions so every ingress into the vault is consistent.
    const values = [...this.registry.values, ...this.admit(opts.values ?? [])];
    this.registrySize = values.length;
    this.vault = new Vault(values);
  }

  get size(): number {
    return this.vault.size;
  }

  /** True when this engine may transform outbound data. */
  get enabled(): boolean {
    return this.size > 0 || this.hasDetectors;
  }

  redactBody(body: string, ctx: Omit<DetectTextContext, "surface"> = {}): BodyRedactionResult {
    this.registerDetectedValues(body, { ...ctx, surface: "body" });
    const redacted = this.vault.redactBody(body);
    return { ...redacted, leaks: this.vault.leakCount(redacted.body) };
  }

  redactText(text: string, ctx: Omit<DetectTextContext, "surface"> = {}): TextRedactionResult {
    this.registerDetectedValues(text, { ...ctx, surface: "header" });
    const redacted = this.vault.redactText(text);
    return { ...redacted, leaks: this.vault.leakCount(redacted.text) };
  }

  restoreText(text: string): string {
    return this.vault.restoreText(text);
  }

  restoreJson(body: string): string {
    return this.vault.restoreJson(body);
  }

  restoreStream(): TransformStream<Uint8Array, Uint8Array> {
    return this.vault.restoreStream();
  }

  restoreEventStream(wire: Wire): TransformStream<Uint8Array, Uint8Array> {
    return this.vault.restoreEventStream(sseRestoreAdapterFor(wire));
  }

  private registerDetectedValues(text: string, ctx: DetectTextContext): number {
    if (!text) return 0;
    let added = 0;
    for (const plugin of this.plugins) {
      let detected: readonly ProtectedValue[];
      try {
        detected = plugin.detectText?.(text, ctx) ?? [];
      } catch {
        // Detector plugins are best-effort and must not take down the exact-match proxy path.
        continue;
      }
      if (detected.length === 0) continue;
      const candidates = detected.map((value) => ({ ...value, plugin: value.plugin ?? plugin.name }));
      added += this.vault.register(this.admit(candidates));
    }
    return added;
  }

  /** Drop named candidates excluded by an enforced (trusted) registry-policy rule. */
  private admit(values: readonly ProtectedValue[]): ProtectedValue[] {
    return values.filter((value) => !protectedValueExcludedBy(value, this.policy));
  }
}
