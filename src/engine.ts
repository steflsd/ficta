import {
  type DetectTextContext,
  defaultPlugins,
  type FictaPlugin,
  loadPluginRegistry,
  type PluginRegistrySnapshot,
  type ProtectedValue,
  pluginsHaveDetectors,
} from "./plugins/index.js";
import { Vault } from "./vault.js";

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

  /** Safe launch-time snapshot of registry-source discovery. */
  readonly registry: PluginRegistrySnapshot;

  /** Number of values loaded at construction time from exact-registry plugins. */
  readonly registrySize: number;

  constructor(opts: ProtectionEngineOptions = {}) {
    this.plugins = opts.plugins ?? defaultPlugins;
    this.hasDetectors = pluginsHaveDetectors(this.plugins);
    this.registry = loadPluginRegistry(this.plugins);
    const values = [...this.registry.values, ...(opts.values ?? [])];
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

  restoreStream(): TransformStream<Uint8Array, Uint8Array> {
    return this.vault.restoreStream();
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
      added += this.vault.register(detected.map((value) => ({ ...value, plugin: value.plugin ?? plugin.name })));
    }
    return added;
  }
}
