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

/** Safe metadata about a protected value that matched. Never includes the protected literal. */
export interface ProtectionHit {
  name: string;
  source: string;
  plugin?: string;
  kind?: ProtectedValue["kind"];
  confidence?: ProtectedValue["confidence"];
}

export interface BodyRedactionDetails extends BodyRedactionResult {
  hits: ProtectionHit[];
  leakHits: ProtectionHit[];
}

export interface TextRedactionDetails extends TextRedactionResult {
  hits: ProtectionHit[];
  leakHits: ProtectionHit[];
}

type TextRedactionContext = Omit<DetectTextContext, "surface"> & { surface?: DetectTextContext["surface"] };

/**
 * Security-critical orchestration layer. Plugins can only add values; the vault does the actual
 * replacement/restore/leak check. That keeps the core invariant testable and plugin-agnostic.
 */
export class ProtectionEngine {
  private readonly plugins: readonly FictaPlugin[];
  private readonly hasDetectors: boolean;
  private readonly vault: Vault;
  private readonly policy: RegistryPolicy;
  private readonly metadataByValue = new Map<string, ProtectedValue[]>();

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
    for (const value of values) this.remember(value);
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
    const details = this.redactBodyDetailed(body, ctx);
    return { body: details.body, count: details.count, leaks: details.leaks };
  }

  redactBodyDetailed(body: string, ctx: Omit<DetectTextContext, "surface"> = {}): BodyRedactionDetails {
    this.registerDetectedValues(body, { ...ctx, surface: "body" });
    const redacted = this.vault.redactBodyDetailed(body);
    const leakValues = this.vault.leakValues(redacted.body);
    return {
      body: redacted.body,
      count: redacted.count,
      leaks: leakValues.length,
      hits: this.hitsFor(redacted.values),
      leakHits: this.hitsFor(leakValues),
    };
  }

  redactText(text: string, ctx: TextRedactionContext = {}): TextRedactionResult {
    const details = this.redactTextDetailed(text, ctx);
    return { text: details.text, count: details.count, leaks: details.leaks };
  }

  redactTextDetailed(text: string, ctx: TextRedactionContext = {}): TextRedactionDetails {
    const { surface = "header", ...rest } = ctx;
    this.registerDetectedValues(text, { ...rest, surface });
    const redacted = this.vault.redactTextDetailed(text);
    const leakValues = this.vault.leakValues(redacted.text);
    return {
      text: redacted.text,
      count: redacted.count,
      leaks: leakValues.length,
      hits: this.hitsFor(redacted.values),
      leakHits: this.hitsFor(leakValues),
    };
  }

  /** Conservative raw-value membership check for deciding whether derived metadata is safe to log. */
  containsProtectedValue(text: string): boolean {
    if (!text) return false;
    for (const value of this.metadataByValue.keys()) if (text.includes(value)) return true;
    return false;
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
      const admitted = this.admit(candidates);
      for (const value of admitted) this.remember(value);
      added += this.vault.register(admitted);
    }
    return added;
  }

  /** Drop named candidates excluded by an enforced (trusted) registry-policy rule. */
  private admit(values: readonly ProtectedValue[]): ProtectedValue[] {
    return values.filter((value) => !protectedValueExcludedBy(value, this.policy));
  }

  private remember(value: ProtectedValue): void {
    if (!value.value) return;
    const existing = this.metadataByValue.get(value.value) ?? [];
    existing.push(value);
    this.metadataByValue.set(value.value, existing);
  }

  private hitsFor(values: readonly string[]): ProtectionHit[] {
    const hits: ProtectionHit[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
      const value = this.metadataByValue.get(raw)?.[0];
      const hit = value === undefined ? unknownHit() : this.hitFromProtectedValue(value);
      const key = JSON.stringify(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
    return hits;
  }

  private hitFromProtectedValue(value: ProtectedValue): ProtectionHit {
    const hit: ProtectionHit = {
      name: this.safeMetadataField(value.name, "<redacted-name>"),
      source: this.safeMetadataField(value.source, "<redacted-source>"),
    };
    if (value.plugin) hit.plugin = this.safeMetadataField(value.plugin, "<redacted-plugin>");
    if (value.kind) hit.kind = value.kind;
    if (value.confidence) hit.confidence = value.confidence;
    return hit;
  }

  private safeMetadataField(value: string | undefined, fallback: string): string {
    const text = value?.trim();
    if (!text) return fallback;
    return this.containsProtectedValue(text) ? fallback : text;
  }
}

function unknownHit(): ProtectionHit {
  return { name: "<unknown>", source: "unknown" };
}
