import { createHash } from "node:crypto";
import { detectorFailClosed } from "./detection-policy.js";
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
import {
  type BodyRedactionDetails,
  DetectorUnavailableError,
  type ProtectionHit,
  type RedactionEngine,
  type RequestScope,
  type TextRedactionContext,
  type TextRedactionDetails,
} from "./redaction-engine.js";
import { redactableBodyLeaves, type ScopedVault, type SurrogateTable, Vault } from "./vault.js";
import type { Wire } from "./wire.js";
import { sseRestoreAdapterFor } from "./wire-restore.js";

export interface ProtectionEngineOptions {
  plugins?: readonly FictaPlugin[];
  values?: readonly ProtectedValue[];
}

/** How long a keyed scope's detected PII may sit idle in memory before it is dropped. */
const KEYED_SCOPE_IDLE_TTL_MS = 30 * 60_000;
/** Upper bound on concurrently-retained keyed scopes (least-recently-used evicted first). */
const KEYED_SCOPE_MAX = 256;

/**
 * Persistent state for one scope key: the detected value↔surrogate layer shared by the key's
 * requests, that layer's value metadata, and hashes of body string-leaves every available detector
 * has already swept (so re-sent transcript prefixes are not re-detected each turn).
 */
interface KeyedScopeState {
  detected: SurrogateTable;
  metadata: Map<string, ProtectedValue[]>;
  seenLeaves: Set<string>;
  lastUsedAt: number;
}

/**
 * Security-critical orchestration layer and the built-in {@link RedactionEngine}. Plugins can only
 * add values; the vault does the actual replacement/restore/leak check. That keeps the core
 * invariant testable and plugin-agnostic.
 *
 * Registered secrets load once into a permanent vault shared by every request. Per-request detected
 * PII is isolated in a {@link ProtectionRequestScope} (see {@link beginRequest}): the proxy opens a
 * fresh scope per request so detected values are bounded and never restored across requests. The
 * engine's own redact/restore methods run against a single implicit default scope — the degenerate
 * "one process, one session" case (CLI agents, direct callers, tests).
 */
export class ProtectionEngine implements RedactionEngine {
  private readonly plugins: readonly FictaPlugin[];
  private readonly hasDetectors: boolean;
  private readonly vault: Vault;
  private readonly policy: RegistryPolicy;
  /** Metadata for permanent (registered) values only; detected-value metadata lives on each scope. */
  private readonly metadataByValue = new Map<string, ProtectedValue[]>();
  /** Persistent per-key scope state (detected layer + metadata + swept-content hashes), LRU-ordered. */
  private readonly keyedScopes = new Map<string, KeyedScopeState>();
  private defaultRequestScope?: ProtectionRequestScope;

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
    const values = [...this.registry.values, ...admit(opts.values ?? [], this.policy)];
    for (const value of values) remember(this.metadataByValue, value);
    this.registrySize = values.length;
    this.vault = new Vault(values);
  }

  get size(): number {
    return this.vault.size;
  }

  /** True when this engine may transform outbound data (has values or a detector is present). */
  get enabled(): boolean {
    return this.size > 0 || this.hasDetectors;
  }

  /**
   * True when protection is actually *configured* — registered values, or a detector reporting
   * itself active via `discover()`. Unlike `enabled` (true whenever a detector is merely present),
   * this is false during pure passthrough (no values, detector disabled), so the banner and request
   * path don't claim to redact when nothing is protected.
   */
  get protecting(): boolean {
    if (this.size > 0) return true;
    const inactive = new Set(["disabled", "not_found", "error"]);
    for (const plugin of this.plugins) {
      if (!plugin.detectText) continue;
      const discoveries = this.registry.discoveries.filter((d) => d.plugin === plugin.name);
      // A detector counts as active unless its own discovery explicitly reports it inactive.
      if (discoveries.length === 0 || discoveries.some((d) => !inactive.has(d.status))) return true;
    }
    return false;
  }

  /**
   * Open a request-scoped view. Without a `scopeKey` the scope is an in-memory ephemeral layer over
   * the shared permanent vault, discarded when the caller drops it (the CLI/agent default).
   *
   * With a `scopeKey` (e.g. the web app's server-derived `org:thread` pair) the scope's detected
   * layer persists across that key's requests: a value detected on turn 1 stays redacted on turn 3
   * even if the detector misses it there, and detection can skip content it already swept (see
   * {@link ProtectionRequestScope.redactBodyDetailed}). Keys must be derived by a trusted caller —
   * the engine treats the key itself as the isolation boundary, exactly like the per-request case:
   * different keys can never restore each other's values. Keyed state holds raw detected PII in
   * memory beyond a single request, so it is bounded by an idle TTL and an LRU cap; eviction only
   * costs re-detection (deterministic surrogates re-mint identically), never a broken restore of a
   * future request.
   */
  beginRequest(scopeKey?: string): RequestScope {
    if (!scopeKey) {
      return new ProtectionRequestScope(this.plugins, this.policy, this.metadataByValue, this.vault.beginScope());
    }
    const state = this.keyedScopeState(scopeKey);
    return new ProtectionRequestScope(
      this.plugins,
      this.policy,
      this.metadataByValue,
      this.vault.beginScope(state.detected),
      state.metadata,
      state.seenLeaves,
    );
  }

  private keyedScopeState(key: string): KeyedScopeState {
    const now = Date.now();
    const existing = this.keyedScopes.get(key);
    if (existing) this.keyedScopes.delete(key); // re-insert below so map order stays least-recently-used-first
    const state = existing ?? {
      detected: this.vault.newDetectedLayer(),
      metadata: new Map<string, ProtectedValue[]>(),
      seenLeaves: new Set<string>(),
      lastUsedAt: now,
    };
    state.lastUsedAt = now;
    this.keyedScopes.set(key, state);
    this.evictKeyedScopes(now);
    return state;
  }

  /** Drop idle keyed scopes and enforce the LRU cap. Map order is LRU because touches re-insert. */
  private evictKeyedScopes(now: number): void {
    for (const [key, state] of this.keyedScopes) {
      const expired = now - state.lastUsedAt > KEYED_SCOPE_IDLE_TTL_MS;
      if (!expired && this.keyedScopes.size <= KEYED_SCOPE_MAX) break;
      this.keyedScopes.delete(key);
    }
  }

  // The engine's own redact/restore surface operates on a single implicit default scope — the
  // degenerate "one process, one session" case (CLI agents, direct callers, tests). The proxy does
  // NOT use these; it opens a fresh scope per request via beginRequest() for isolation.
  private get defaultScope(): ProtectionRequestScope {
    if (!this.defaultRequestScope) {
      this.defaultRequestScope = new ProtectionRequestScope(
        this.plugins,
        this.policy,
        this.metadataByValue,
        this.vault.beginScope(),
      );
    }
    return this.defaultRequestScope;
  }

  redactBodyDetailed(body: string, ctx: Omit<DetectTextContext, "surface"> = {}): Promise<BodyRedactionDetails> {
    return this.defaultScope.redactBodyDetailed(body, ctx);
  }

  redactTextDetailed(text: string, ctx: TextRedactionContext = {}): Promise<TextRedactionDetails> {
    return this.defaultScope.redactTextDetailed(text, ctx);
  }

  /** Conservative raw-value membership check for deciding whether derived metadata is safe to log. */
  containsProtectedValue(text: string): boolean {
    return this.defaultScope.containsProtectedValue(text);
  }

  restoreText(text: string): string {
    return this.defaultScope.restoreText(text);
  }

  restoreJson(body: string): string {
    return this.defaultScope.restoreJson(body);
  }

  restoreStream(): TransformStream<Uint8Array, Uint8Array> {
    return this.defaultScope.restoreStream();
  }

  restoreEventStream(wire: Wire): TransformStream<Uint8Array, Uint8Array> {
    return this.defaultScope.restoreEventStream(wire);
  }
}

/**
 * One request's worth of redaction. Detection performed through it registers into the scope's
 * ephemeral vault layer and a scope-local metadata map, so nothing detected here mutates the shared
 * permanent vault or engine metadata. Restore and the `containsProtectedValue` check consult the
 * detected layer first, then the permanent one. When the scope is dropped at request end its detected
 * PII is garbage-collected and can never be restored into a later request's response.
 */
class ProtectionRequestScope implements RequestScope {
  constructor(
    private readonly plugins: readonly FictaPlugin[],
    private readonly policy: RegistryPolicy,
    private readonly permanentMetadata: ReadonlyMap<string, ProtectedValue[]>,
    private readonly vault: ScopedVault,
    private readonly detectedMetadata: Map<string, ProtectedValue[]> = new Map(),
    /** Present only for keyed scopes: leaf hashes already swept by every available detector. */
    private readonly seenLeaves?: Set<string>,
  ) {}

  async redactBodyDetailed(body: string, ctx: Omit<DetectTextContext, "surface"> = {}): Promise<BodyRedactionDetails> {
    // Detect over the redactable text surface (JSON string leaves), not the raw body, so a value is
    // detected iff redaction can rewrite it — number-only leaves are neither, avoiding a fail-closed
    // reject on PII we could not have removed anyway. See redactableBodyLeaves.
    //
    // Keyed scopes detect incrementally: a leaf every available detector has already swept in this
    // scope is skipped, so turn N of a resent transcript only pays detection for its new content —
    // and old content cannot be reinterpreted into new detections later. Redaction and the leak
    // gate still run over the FULL body with all of the scope's known values, so skipping detection
    // never skips protection. Leaves are marked swept only when no detector was unavailable, so a
    // recovering detector gets a full pass at anything it missed.
    const leaves = redactableBodyLeaves(body);
    const seen = this.seenLeaves;
    const hashes = seen ? leaves.map(leafHash) : [];
    const fresh = seen ? leaves.filter((_, i) => !seen.has(hashes[i] ?? "")) : leaves;
    const complete = await this.registerDetectedValues(fresh.join("\n"), { ...ctx, surface: "body" });
    if (seen && complete) for (const hash of hashes) seen.add(hash);
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

  async redactTextDetailed(text: string, ctx: TextRedactionContext = {}): Promise<TextRedactionDetails> {
    const { surface = "header", ...rest } = ctx;
    await this.registerDetectedValues(text, { ...rest, surface });
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

  get restoredCount(): number {
    return this.vault.restoredCount;
  }

  /** Membership check over this scope's detected values and the permanent registry. */
  containsProtectedValue(text: string): boolean {
    if (!text) return false;
    for (const value of this.detectedMetadata.keys()) if (text.includes(value)) return true;
    for (const value of this.permanentMetadata.keys()) if (text.includes(value)) return true;
    return false;
  }

  /** Returns true when every detector ran (nothing was skipped by a fail-open outage or crash). */
  private async registerDetectedValues(text: string, ctx: DetectTextContext): Promise<boolean> {
    if (!text) return true;
    let complete = true;
    for (const plugin of this.plugins) {
      let detected: readonly ProtectedValue[];
      try {
        detected = (await plugin.detectText?.(text, ctx)) ?? [];
      } catch (err) {
        // Detector plugins are best-effort and must not take down the exact-match proxy path. A
        // detector only *signals* a backend outage (DetectorUnavailableError); core owns the policy:
        // resolve the detector's own fail-closed override against the global default and either block
        // (re-raise → server.ts refuses to forward) or skip detection for this request (continue).
        if (err instanceof DetectorUnavailableError) {
          const override = plugin.kind === "detector" ? plugin.failClosed?.() : undefined;
          if (detectorFailClosed(override)) throw err;
          complete = false;
          continue;
        }
        complete = false;
        continue;
      }
      if (detected.length === 0) continue;
      const candidates = detected.map((value) => ({ ...value, plugin: value.plugin ?? plugin.name }));
      const admitted = admit(candidates, this.policy);
      for (const value of admitted) remember(this.detectedMetadata, value);
      this.vault.register(admitted);
    }
    return complete;
  }

  /** Metadata for a raw value: this request's detected values take precedence over the permanent registry. */
  private metadataFor(raw: string): ProtectedValue | undefined {
    return (this.detectedMetadata.get(raw) ?? this.permanentMetadata.get(raw))?.[0];
  }

  private hitsFor(values: readonly string[]): ProtectionHit[] {
    const hits: ProtectionHit[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
      const value = this.metadataFor(raw);
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

/** Content hash for the swept-leaf ledger; hashes are retained, never the leaf text itself. */
function leafHash(leaf: string): string {
  return createHash("sha256").update(leaf).digest("hex");
}

/** Drop named candidates excluded by an enforced (trusted) registry-policy rule. */
function admit(values: readonly ProtectedValue[], policy: RegistryPolicy): ProtectedValue[] {
  return values.filter((value) => !protectedValueExcludedBy(value, policy));
}

function remember(metadata: Map<string, ProtectedValue[]>, value: ProtectedValue): void {
  if (!value.value) return;
  const existing = metadata.get(value.value) ?? [];
  existing.push(value);
  metadata.set(value.value, existing);
}

function unknownHit(): ProtectionHit {
  return { name: "<unknown>", source: "unknown" };
}
