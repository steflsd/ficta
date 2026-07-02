import type { DetectTextContext, PluginRegistrySnapshot, ProtectedValue } from "./plugins/index.js";
import type { Wire } from "./wire.js";

/**
 * The redaction contract the proxy (`server.ts`) depends on — the seam that lets an engine be
 * swapped without touching the transport. `ProtectionEngine` is the built-in implementation; a
 * different engine (e.g. a per-tenant or remote one) only has to satisfy this interface.
 *
 * Invariant preserved by any implementation: it may only redact (tokenize) outbound data and
 * restore it on responses — it never sees or forwards auth headers, and never logs raw values.
 */
export interface RedactionEngine {
  /** True when the engine may transform outbound data (has registered values or detectors). */
  readonly enabled: boolean;

  /** True when protection is actually configured (registered values or an active detector). */
  readonly protecting: boolean;

  /**
   * Redact a request body (JSON-aware) and report which values matched / leaked. Async because
   * detection may hit an out-of-process recognizer (e.g. a Presidio/NER sidecar).
   */
  redactBodyDetailed(body: string, ctx?: Omit<DetectTextContext, "surface">): Promise<BodyRedactionDetails>;

  /** Redact a raw string (header value, query component) and report matches / leaks. Async: see above. */
  redactTextDetailed(text: string, ctx?: TextRedactionContext): Promise<TextRedactionDetails>;

  /** Restore surrogates → real values in a chunk of text. */
  restoreText(text: string): string;

  /** Restore surrogates in a JSON body, escaping each restored value for its string context. */
  restoreJson(body: string): string;

  /** Streaming restore for non-SSE response bodies (holds back partial surrogates at chunk edges). */
  restoreStream(): TransformStream<Uint8Array, Uint8Array>;

  /** Streaming restore for a provider SSE stream, using the wire-specific reassembly adapter. */
  restoreEventStream(wire: Wire): TransformStream<Uint8Array, Uint8Array>;

  /** Conservative membership check used to keep derived metadata (paths, model names) safe to log. */
  containsProtectedValue(text: string): boolean;

  /**
   * Open a request-scoped view of the engine. Registered secrets (the permanent layer) are shared
   * and unchanged; values detected while redacting this request live in an ephemeral layer that is
   * consulted only for *this* request's restore and is discarded when the returned scope is dropped.
   * That bounds detected-PII memory and keeps one request's detected values from being restored into
   * another's response. `scopeKey` is the seam for a future persistent/shared vault (session/org):
   * ignored today (always an in-memory ephemeral scope). The engine's own `redactBodyDetailed` /
   * `restoreText` / … operate on a single implicit default scope — the degenerate CLI case.
   */
  beginRequest(scopeKey?: string): RequestScope;

  // --- Diagnostics / introspection consumed by the proxy startup banner + ProxyHandle. ---

  /** Number of protected values currently loaded. */
  readonly size: number;

  /** Safe launch-time snapshot of registry-source discovery (counts, names — never values). */
  readonly registry: PluginRegistrySnapshot;
}

/**
 * A request-scoped redact/restore surface. Detection performed through it registers into an
 * ephemeral per-request layer (not the shared permanent vault); restore consults that layer first,
 * then the permanent one. Obtained from {@link RedactionEngine.beginRequest}; used by the proxy for
 * exactly one request and then discarded.
 */
export interface RequestScope {
  /** Redact a request body (JSON-aware); detected values enter this scope's ephemeral layer. */
  redactBodyDetailed(body: string, ctx?: Omit<DetectTextContext, "surface">): Promise<BodyRedactionDetails>;

  /** Redact a raw string (header value, query component); detected values enter this scope. */
  redactTextDetailed(text: string, ctx?: TextRedactionContext): Promise<TextRedactionDetails>;

  /** Restore surrogates → real values in a chunk of text (scope-detected then permanent). */
  restoreText(text: string): string;

  /** Restore surrogates in a JSON body, escaping each restored value for its string context. */
  restoreJson(body: string): string;

  /** Streaming restore for non-SSE response bodies (holds back partial surrogates at chunk edges). */
  restoreStream(): TransformStream<Uint8Array, Uint8Array>;

  /** Streaming restore for a provider SSE stream, using the wire-specific reassembly adapter. */
  restoreEventStream(wire: Wire): TransformStream<Uint8Array, Uint8Array>;

  /** Membership check over permanent + this scope's detected values, to keep derived metadata safe to log. */
  containsProtectedValue(text: string): boolean;

  /**
   * Distinct values restored back into this request's response so far. Read after the response body
   * drains (streaming) or is built (buffered) to log the symmetric `♻️ restored N value(s)` line.
   */
  readonly restoredCount: number;
}

/** Optional context for text redaction: which surface/header/path the text came from. */
export type TextRedactionContext = Omit<DetectTextContext, "surface"> & { surface?: DetectTextContext["surface"] };

/** Safe metadata about a protected value that matched. Never includes the protected literal. */
export interface ProtectionHit {
  name: string;
  source: string;
  plugin?: string;
  kind?: ProtectedValue["kind"];
  confidence?: ProtectedValue["confidence"];
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

export interface BodyRedactionDetails extends BodyRedactionResult {
  hits: ProtectionHit[];
  leakHits: ProtectionHit[];
}

export interface TextRedactionDetails extends TextRedactionResult {
  hits: ProtectionHit[];
  leakHits: ProtectionHit[];
}

/**
 * Neutral signal from a detector that its backend could not run (e.g. an out-of-process recognizer
 * is unreachable). It carries no policy — the *core* decides whether an outage is fatal, resolving the
 * per-plugin `failClosed()` override against the global default and either re-raising this to block the
 * request or swallowing it to continue best-effort. `reason` is safe metadata (failure category) —
 * never request text or protected values.
 */
export class DetectorUnavailableError extends Error {
  constructor(
    readonly plugin: string,
    readonly reason?: string,
  ) {
    super(reason ? `detector "${plugin}" unavailable: ${reason}` : `detector "${plugin}" unavailable`);
    this.name = "DetectorUnavailableError";
  }
}
