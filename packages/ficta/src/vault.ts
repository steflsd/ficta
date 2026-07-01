import { envFlag } from "./env-flags.js";
import { hexSurrogateStrategy, type SurrogateStrategy } from "./surrogate.js";

/**
 * The vault: redact registered/detected values → surrogates on the way up, restore them on the
 * way back. Surrogates are keyed deterministic within the local proxy process (same value → same
 * token across turns; set FICTA_SURROGATE_KEY for cross-restart stability) and JSON-safe
 * (alphanumeric + underscore, so substituting them never breaks JSON).
 *
 * The vault is intentionally plugin-agnostic. Plugins/engine decide what values enter it; the
 * vault owns the security-critical mechanics: deterministic tokenization, exact replacement,
 * fail-closed leak scanning, and streaming restore.
 */

const ENV_SURROGATE_KEY = process.env.FICTA_SURROGATE_KEY;

export interface VaultValue {
  value: string;
}

export function surrogateKeyWarning(): string | undefined {
  if (!ENV_SURROGATE_KEY) return undefined;
  if (Buffer.byteLength(ENV_SURROGATE_KEY, "utf8") < 32 || new Set(ENV_SURROGATE_KEY).size < 8) {
    return "FICTA_SURROGATE_KEY is set but looks weak; use a high-entropy secret value (>=32 random bytes)";
  }
  return undefined;
}

/**
 * A mutable surrogate store: the deterministic value↔surrogate dictionary plus the longest-first
 * value list used for redaction. One store per protection *layer* — the permanent registry
 * (registered secrets, process-lifetime) and each request's ephemeral detected-PII layer are
 * separate stores that share a single {@link SurrogateStrategy}, so the same raw value mints the
 * same surrogate in either layer (deterministic HMAC → cross-turn/cross-layer consistency).
 */
export class SurrogateTable {
  readonly values: string[] = []; // known values, longest first
  private readonly seen = new Set<string>();
  readonly toSur = new Map<string, string>();
  readonly toVal = new Map<string, string>();

  constructor(readonly surrogate: SurrogateStrategy) {}

  get size(): number {
    return this.values.length;
  }

  /**
   * Register additional values, e.g. from request-time detector plugins. The store is name-blind, so
   * it cannot apply registry-policy exclusions itself: that enforcement happens upstream where names
   * are still known — `loadPluginRegistry` for launch values and `ProtectionEngine.admit()` for
   * detector/caller-supplied values. Any new code path that registers named candidates must filter
   * through `admit()` first, or excluded names will silently re-enter protection.
   */
  register(values: ReadonlyArray<VaultValue>): number {
    let added = 0;
    for (const item of values) {
      const value = item.value;
      if (!value || this.seen.has(value)) continue;
      this.seen.add(value);
      this.values.push(value);
      const sur = this.surrogate.mint(value);
      this.toSur.set(value, sur);
      this.toVal.set(sur, value);
      added++;
    }
    if (added > 0) this.values.sort((a, b) => b.length - a.length);
    return added;
  }
}

/**
 * Read/redact/restore mechanics over one or more {@link SurrogateTable} layers, consulted in
 * precedence order (first match wins). A permanent {@link Vault} is a view over a single table; a
 * per-request {@link ScopedVault} is a view over `[detected, permanent]`. All the security-critical
 * mechanics (exact replacement, fail-closed leak scanning, streaming restore) live here exactly
 * once, so the CLI single-vault path and the request-scoped gateway path share the same tested code.
 */
export abstract class VaultView {
  /**
   * Distinct raw values this view has restored back into responses. Populated by `restoreText` /
   * `restoreJsonText`, so it spans buffered and streaming restore alike; the proxy reads its size
   * after a response drains to log the symmetric `♻️ restored N value(s)` line. A scope restores only
   * on its one response, so for a request scope this equals that response's restore count.
   */
  readonly restored = new Set<string>();

  protected constructor(private readonly layers: readonly [SurrogateTable, ...SurrogateTable[]]) {}

  /** How many distinct values this view has restored into responses so far. */
  get restoredCount(): number {
    return this.restored.size;
  }

  /** Shared across all layers (a single injected strategy), so any layer's is the strategy. */
  protected get surrogate(): SurrogateStrategy {
    return this.layers[0].surrogate;
  }

  /** Any layer holds a value to redact. */
  private get hasValues(): boolean {
    return this.layers.some((layer) => layer.size > 0);
  }

  /** Any layer holds a surrogate to restore. */
  private get hasSurrogates(): boolean {
    return this.layers.some((layer) => layer.toVal.size > 0);
  }

  /** Known raw values across all layers, longest first (a longer value redacts before a substring). */
  private orderedValues(): readonly string[] {
    if (this.layers.length === 1) return this.layers[0].values; // already sorted, no merge needed
    const seen = new Set<string>();
    const out: string[] = [];
    for (const layer of this.layers) {
      for (const value of layer.values) {
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
    }
    out.sort((a, b) => b.length - a.length);
    return out;
  }

  private surrogateFor(value: string): string | undefined {
    for (const layer of this.layers) {
      const sur = layer.toSur.get(value);
      if (sur !== undefined) return sur;
    }
    return undefined;
  }

  private valueFor(surrogate: string): string | undefined {
    for (const layer of this.layers) {
      const value = layer.toVal.get(surrogate);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** Redact known values in a raw string. */
  redactText(text: string): { text: string; count: number } {
    const result = this.redactTextDetailed(text);
    return { text: result.text, count: result.count };
  }

  /** Redact known values in a raw string and report which raw values matched. */
  redactTextDetailed(text: string): { text: string; count: number; values: string[] } {
    if (!this.hasValues || !text) return { text, count: 0, values: [] };
    const found = new Set<string>();
    return { text: this.replaceKnown(text, found), count: found.size, values: [...found] };
  }

  /**
   * Redact a request body. Parses JSON and replaces inside string leaves and object keys so
   * escaping stays correct; falls back to raw string replace for non-JSON. Returns the new body +
   * how many distinct known values were swapped out.
   */
  redactBody(body: string): { body: string; count: number } {
    const result = this.redactBodyDetailed(body);
    return { body: result.body, count: result.count };
  }

  /** Redact a request body and report which raw values matched. */
  redactBodyDetailed(body: string): { body: string; count: number; values: string[] } {
    if (!this.hasValues || !body) return { body, count: 0, values: [] };
    const found = new Set<string>();
    const replace = (s: string): string => this.replaceKnown(s, found);
    try {
      const mapped = mapStrings(JSON.parse(body), replace);
      return { body: found.size > 0 ? JSON.stringify(mapped) : body, count: found.size, values: [...found] };
    } catch {
      return { body: replace(body), count: found.size, values: [...found] };
    }
  }

  private replaceKnown(text: string, found: Set<string>): string {
    let out = text;
    for (const v of this.orderedValues()) {
      if (!out.includes(v)) continue;
      const surrogate = this.surrogateFor(v);
      if (surrogate === undefined) continue;
      const replaced = replaceKnownOutsidePaths(out, v, surrogate);
      if (replaced.count === 0) continue;
      found.add(v);
      out = replaced.text;
    }
    return out;
  }

  /** Restore surrogates → real values in a chunk of text. */
  restoreText(text: string): string {
    if (!this.hasSurrogates || !text) return text;
    return text.replace(this.surrogate.pattern, (m) => {
      const value = this.valueFor(m);
      if (value === undefined) return m;
      this.restored.add(value);
      return value;
    });
  }

  /**
   * Restore a JSON response body. Surrogates only ever sit inside JSON string literals/keys (they
   * are substituted into strings on the way up), so they are swapped back in place with the restored
   * value escaped for its string context. That keeps the document valid even when a restored value
   * contains `"`, `\`, or a newline (a quoted password, a multi-line PEM key) — a raw `restoreText`
   * would break the literal — while leaving every other byte untouched. A JSON.parse/JSON.stringify
   * round-trip would instead silently round integers > 2^53 and reformat numbers. Falls back to raw
   * text restore for bodies that are not valid JSON.
   */
  restoreJson(body: string): string {
    if (!this.hasSurrogates || !body) return body;
    try {
      JSON.parse(body);
    } catch {
      return this.restoreText(body);
    }
    return this.restoreJsonText(body);
  }

  /** In-place surrogate restore for JSON text, escaping each value for its string context. */
  restoreJsonText(text: string): string {
    if (!this.hasSurrogates || !text) return text;
    return text.replace(this.surrogate.pattern, (m) => {
      const value = this.valueFor(m);
      if (value === undefined) return m;
      this.restored.add(value);
      return jsonStringEscape(value);
    });
  }

  /**
   * Fail-closed gate: how many registered/detected values are still present in an
   * already-redacted outbound body/text. Must be 0 before we forward. JSON redaction
   * intentionally only mutates strings/keys so primitive numbers keep their type; the raw
   * body backstop catches numeric-looking values that survived that semantic pass.
   */
  leakCount(body: string): number {
    return this.leakValues(body).length;
  }

  /** Raw registered/detected values that still survive in already-redacted outbound text/body. */
  leakValues(body: string): string[] {
    if (!this.hasValues || !body) return [];
    const strings: string[] = [];
    let masked: string | undefined;
    try {
      collectStrings(JSON.parse(body), strings);
      masked = maskJsonStringLiterals(body);
    } catch {
      // Non-JSON: the whole raw body is scanned for any known value below.
    }
    const leaked: string[] = [];
    for (const v of this.orderedValues()) {
      const stringLeak = strings.some((s) => containsKnownOutsidePaths(s, v));
      // For valid JSON, string contents are masked out, so the backstop scans only primitives and
      // matches a value as a complete token — never as a substring of a longer number (so a
      // registered `12345678` is not flagged inside an unrelated `99912345678`).
      const primitiveLeak =
        masked === undefined ? containsKnownOutsidePaths(body, v) : containsKnownPrimitive(masked, v);
      if (stringLeak || primitiveLeak) leaked.push(v);
    }
    return leaked;
  }

  /**
   * A TransformStream that restores surrogates in a streamed response. Holds back a short tail
   * each chunk so a surrogate split across chunk boundaries is never emitted half-restored.
   */
  restoreStream(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const HOLD = this.surrogate.maxLength - 1; // max partial surrogate; a full token is maxLength chars
    let buf = "";
    const self = this;
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // Restore complete surrogates in the full buffer; only a partial token can remain at the tail.
        buf = self.restoreText(buf + decoder.decode(chunk, { stream: true }));
        if (buf.length > HOLD) {
          controller.enqueue(encoder.encode(buf.slice(0, buf.length - HOLD)));
          buf = buf.slice(buf.length - HOLD);
        }
      },
      flush(controller) {
        buf = self.restoreText(buf + decoder.decode());
        if (buf) controller.enqueue(encoder.encode(buf));
      },
    });
  }

  /**
   * SSE restore for provider streams that carry text/tool-call arguments as JSON string fragments.
   * A surrogate can be split across adjacent SSE events even when the raw bytes are not adjacent;
   * the provider-specific `adapter` (see wire-restore.ts) names which semantic fragments to buffer
   * until they can be restored. The vault owns only the generic, provider-agnostic SSE mechanics.
   */
  restoreEventStream(adapter: SseRestoreAdapter): TransformStream<Uint8Array, Uint8Array> {
    return createSseRestoreStream(
      (text) => this.restoreText(text),
      (text) => this.restoreJsonText(text),
      adapter,
      this.surrogate,
    );
  }
}

/**
 * The permanent vault: registered/launch-time values (registered secrets), loaded once and shared
 * across every request. Behaviour is identical to the pre-scope single vault — this is what keeps
 * the CLI paradigm (protect codex/pi/claude from leaking registered secrets) working unchanged.
 * Request-time detected PII must NOT be registered here; open a {@link ScopedVault} via
 * {@link beginScope} so detected values live and die with a single request.
 */
export class Vault extends VaultView {
  private readonly permanent: SurrogateTable;

  constructor(values: ReadonlyArray<VaultValue> = [], surrogate: SurrogateStrategy = hexSurrogateStrategy()) {
    const permanent = new SurrogateTable(surrogate);
    permanent.register(values);
    super([permanent]);
    this.permanent = permanent;
  }

  get size(): number {
    return this.permanent.size;
  }

  /** Register additional permanent values (launch-time registry ingress only). See {@link SurrogateTable.register}. */
  register(values: ReadonlyArray<VaultValue>): number {
    return this.permanent.register(values);
  }

  /**
   * Open a per-request scope: an ephemeral detected-PII layer stacked over this permanent vault,
   * sharing its {@link SurrogateStrategy}. Detected values register into the scope only and are
   * discarded when the scope is dropped, so they neither grow the permanent vault nor leak across
   * requests. Restore/leak/redact in the scope consult detected-then-permanent.
   */
  beginScope(): ScopedVault {
    return new ScopedVault(this.permanent);
  }
}

/**
 * A request-scoped vault: an ephemeral detected-value layer over the shared permanent vault. Created
 * per request via {@link Vault.beginScope}; detection registers into the detected layer, and the
 * whole scope (with its detected surrogates) is garbage-collected when the request handler returns.
 * This bounds memory and — because the detected `toVal` is private to the scope — prevents one
 * request's PII from being restored into another request's response.
 */
export class ScopedVault extends VaultView {
  private readonly detected: SurrogateTable;

  constructor(permanent: SurrogateTable) {
    const detected = new SurrogateTable(permanent.surrogate); // shares the strategy → same surrogates
    super([detected, permanent]);
    this.detected = detected;
  }

  /** Register request-detected values into the ephemeral layer only (never the permanent vault). */
  register(values: ReadonlyArray<VaultValue>): number {
    return this.detected.register(values);
  }

  /** Count of ephemeral values detected in this request (the permanent layer is excluded). */
  get detectedSize(): number {
    return this.detected.size;
  }
}

interface SseField {
  raw: string;
  name?: string;
  value?: string;
}

interface SseRecord {
  fields: SseField[];
  data?: string;
  eventName?: string;
}

interface PendingSseFragment {
  value: string;
  eventName?: string;
  flushData: (value: string) => Record<string, unknown>;
}

export interface StreamingTextFragment extends PendingSseFragment {
  key: string;
  setValue: (value: string) => void;
}

/**
 * Provider-specific knowledge the generic SSE restore needs: which fields in a parsed event are
 * incremental text fragments to accumulate/restore, and which events signal a logical end (so any
 * held partial surrogate can be flushed). Implemented per wire in wire-restore.ts.
 */
export interface SseRestoreAdapter {
  fragments(data: unknown, eventName?: string): StreamingTextFragment[];
  stopPrefixes(data: unknown): string[];
}

function createSseRestoreStream(
  restoreText: (text: string) => string,
  restoreJsonText: (text: string) => string,
  adapter: SseRestoreAdapter,
  surrogate: SurrogateStrategy,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending = new Map<string, PendingSseFragment>();
  let buf = "";

  const encode = (text: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (text) controller.enqueue(encoder.encode(text));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = findSseRecordBoundary(buf);
        if (!boundary) break;
        const record = buf.slice(0, boundary.index + boundary.length);
        buf = buf.slice(boundary.index + boundary.length);
        encode(restoreSseRecord(record, pending, restoreText, restoreJsonText, adapter, surrogate), controller);
      }
    },
    flush(controller) {
      buf += decoder.decode();
      if (buf) encode(restoreSseRecord(buf, pending, restoreText, restoreJsonText, adapter, surrogate), controller);
      encode(flushPendingSseFragments(pending, restoreText), controller);
    },
  });
}

function restoreSseRecord(
  record: string,
  pending: Map<string, PendingSseFragment>,
  restoreText: (text: string) => string,
  restoreJsonText: (text: string) => string,
  adapter: SseRestoreAdapter,
  surrogate: SurrogateStrategy,
): string {
  const parsed = parseSseRecord(record);
  if (parsed.data?.trim() === "[DONE]") {
    return flushPendingSseFragments(pending, restoreText) + restoreText(record);
  }

  let data: unknown;
  if (parsed.data !== undefined) {
    try {
      data = JSON.parse(parsed.data);
    } catch {
      return restoreText(record);
    }
  }

  let prefix = "";
  for (const stopPrefix of adapter.stopPrefixes(data)) {
    prefix += flushPendingSseFragments(pending, restoreText, stopPrefix);
  }

  const fragments = adapter.fragments(data, parsed.eventName);
  if (fragments.length === 0) {
    // No incremental fragments to reassemble. If the event body parsed as JSON, restore surrogates
    // inside its `data:` payload in place (escaping each restored value for its string context) so
    // numbers and formatting survive untouched; otherwise fall back to a raw text restore.
    return data === undefined
      ? prefix + restoreText(record)
      : prefix + renderSseRecordRawData(parsed, restoreJsonText(parsed.data ?? ""));
  }

  for (const fragment of fragments) {
    const combined = (pending.get(fragment.key)?.value ?? "") + fragment.value;
    const restored = restoreText(combined);
    const { emit, hold } = splitForPotentialSurrogate(restored, surrogate);
    if (hold) pending.set(fragment.key, { value: hold, eventName: fragment.eventName, flushData: fragment.flushData });
    else pending.delete(fragment.key);
    fragment.setValue(emit);
  }

  // Fragment fields now hold restored text (any partial-surrogate tail lives in `pending`), so a
  // deep restore over the parsed record only touches sibling fields the adapter does not name
  // (e.g. an OpenAI delta's reasoning_content/refusal). JSON serialization re-escapes them.
  return prefix + renderSseJsonRecord(parsed, mapStrings(data, restoreText));
}

function flushPendingSseFragments(
  pending: Map<string, PendingSseFragment>,
  restoreText: (text: string) => string,
  keyPrefix = "",
): string {
  let out = "";
  for (const [key, fragment] of [...pending]) {
    if (keyPrefix && !key.startsWith(keyPrefix)) continue;
    const value = restoreText(fragment.value);
    if (value) out += renderSseDataEvent(fragment.eventName, fragment.flushData(value));
    pending.delete(key);
  }
  return out;
}

function splitForPotentialSurrogate(text: string, surrogate: SurrogateStrategy): { emit: string; hold: string } {
  const max = Math.min(surrogate.maxLength - 1, text.length);
  for (let length = max; length > 0; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (surrogate.isPotentialPrefix(suffix)) {
      return { emit: text.slice(0, text.length - length), hold: suffix };
    }
  }
  return { emit: text, hold: "" };
}

function findSseRecordBoundary(text: string): { index: number; length: number } | undefined {
  const candidates = [
    { index: text.indexOf("\r\n\r\n"), length: 4 },
    { index: text.indexOf("\n\n"), length: 2 },
    { index: text.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index !== -1);
  return candidates.sort((a, b) => a.index - b.index)[0];
}

function parseSseRecord(record: string): SseRecord {
  const body = record.replace(/(?:\r\n\r\n|\n\n|\r\r)$/, "");
  const lines = body ? body.split(/\r\n|\n|\r/) : [];
  const fields = lines.map(parseSseField);
  const data = fields
    .filter((field) => field.name === "data")
    .map((field) => field.value ?? "")
    .join("\n");
  let eventName: string | undefined;
  for (const field of fields) if (field.name === "event") eventName = field.value;
  return { fields, data: data || undefined, eventName };
}

function parseSseField(line: string): SseField {
  if (line.startsWith(":")) return { raw: line };
  const colon = line.indexOf(":");
  if (colon === -1) return { raw: line, name: line, value: "" };
  const name = line.slice(0, colon);
  const rawValue = line.slice(colon + 1);
  const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
  return { raw: line, name, value };
}

function renderSseJsonRecord(record: SseRecord, data: unknown): string {
  return renderSseRecordRawData(record, JSON.stringify(data));
}

/** Re-render an SSE record, replacing its `data:` field(s) with already-serialized JSON text. */
function renderSseRecordRawData(record: SseRecord, dataText: string): string {
  const lines = record.fields.filter((field) => field.name !== "data").map((field) => field.raw);
  lines.push(`data: ${dataText}`);
  return `${lines.join("\n")}\n\n`;
}

function renderSseDataEvent(eventName: string | undefined, data: unknown): string {
  const lines = eventName ? [`event: ${eventName}`] : [];
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function replaceKnownOutsidePaths(text: string, needle: string, replacement: string): { text: string; count: number } {
  if (!needle) return { text, count: 0 };

  let out = "";
  let cursor = 0;
  let count = 0;

  for (;;) {
    const index = text.indexOf(needle, cursor);
    if (index === -1) break;

    const end = index + needle.length;
    if (isInsidePathLikeToken(text, index, end, needle)) {
      out += text.slice(cursor, end);
    } else {
      out += text.slice(cursor, index) + replacement;
      count++;
    }
    cursor = end;
  }

  if (count === 0) return { text, count: 0 };
  return { text: out + text.slice(cursor), count };
}

/**
 * Backstop leak check for a registered value that survives the string-only redaction pass as a bare
 * JSON primitive (e.g. a number). `maskJsonStringLiterals` has already blanked every string's
 * contents, so only primitives + structure remain; match `needle` as a complete token, never as a
 * substring of a longer number (a registered `12345678` must not register inside `99912345678`).
 */
function containsKnownPrimitive(masked: string, needle: string): boolean {
  if (!needle) return false;
  let cursor = 0;
  for (;;) {
    const index = masked.indexOf(needle, cursor);
    if (index === -1) return false;
    if (!isTokenContinuation(masked[index - 1]) && !isTokenContinuation(masked[index + needle.length])) return true;
    cursor = index + 1;
  }
}

function isTokenContinuation(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_.+-]/.test(ch);
}

function jsonStringEscape(value: string): string {
  // JSON.stringify yields a fully-escaped, quoted string literal; drop the surrounding quotes to get
  // content safe to substitute inside an existing JSON string.
  const json = JSON.stringify(value);
  return json.slice(1, -1);
}

function containsKnownOutsidePaths(text: string, needle: string): boolean {
  if (!needle) return false;
  let cursor = 0;
  for (;;) {
    const index = text.indexOf(needle, cursor);
    if (index === -1) return false;
    const end = index + needle.length;
    if (!isInsidePathLikeToken(text, index, end, needle)) return true;
    cursor = end;
  }
}

function isInsidePathLikeToken(text: string, start: number, end: number, needle?: string): boolean {
  if (redactPathsEnabled()) return false;

  const [tokenStart, tokenEnd] = tokenBounds(text, start, end);
  const token = text.slice(tokenStart, tokenEnd);
  const pathKind = pathLikeKind(token);
  const shellPathArg = isShellPathArgument(text, tokenStart);
  if (!pathKind && !shellPathArg) return false;

  if (needle === undefined || canPreservePathSegmentOccurrence(needle)) return true;
  if (shellPathArg) return true;
  if (pathKind === "explicit" && !isAssignmentValue(text, tokenStart)) return true;
  return false;
}

function canPreservePathSegmentOccurrence(needle: string): boolean {
  // Path preservation always applies to simple path-segment-like values (for example an AWS region
  // or profile name) embedded in paths. More complex values containing '/', '\\', quotes,
  // whitespace, or control characters are only preserved in stronger path contexts below.
  return /^[A-Za-z0-9_.:@+=-]+$/.test(needle);
}

function redactPathsEnabled(): boolean {
  return envFlag(process.env.FICTA_REDACT_PATHS);
}

function tokenBounds(text: string, start: number, end: number): [number, number] {
  let left = start;
  while (left > 0 && !isTokenBoundary(text[left - 1] ?? "")) left--;

  let right = end;
  while (right < text.length && !isTokenBoundary(text[right] ?? "")) right++;

  return [left, right];
}

function isTokenBoundary(ch: string): boolean {
  return ch === "" || /\s/.test(ch) || "=\"'`<>(){}[],;|&".includes(ch);
}

type PathLikeKind = "explicit" | "relative";

function pathLikeKind(token: string): PathLikeKind | undefined {
  const value = trimPathPunctuation(token);
  if (!value) return undefined;

  const scheme = value.match(/[A-Za-z][A-Za-z0-9+.-]*:\/\//);
  if (scheme) return value.slice(scheme.index).toLowerCase().startsWith("file://") ? "explicit" : undefined;

  if (/^(?:\/|~\/|\.\/|\.\.\/)/.test(value)) return "explicit";
  if (/^[A-Za-z]:[\\/]/.test(value)) return "explicit";
  if (value.includes("/") || value.includes("\\")) return "relative";
  return undefined;
}

function isAssignmentValue(text: string, tokenStart: number): boolean {
  return tokenStart > 0 && text[tokenStart - 1] === "=";
}

function isShellPathArgument(text: string, tokenStart: number): boolean {
  const before = text.slice(0, tokenStart);
  const segment = before.slice(lastShellSeparatorIndex(before) + 1).replace(/["'`]+$/g, "");

  // Bare directory names are path-like when they are the path operand of common directory-changing
  // forms. This prevents cwd/project names such as "eu-central-1-prod" from becoming unusable
  // `cd FICTA_...` commands, while still redacting ordinary env assignments like
  // `AWS_PROFILE=eu-central-1-prod`.
  if (/(^|[\s(])(?:cd|pushd)\s+$/.test(segment)) return true;
  if (/(^|[\s(])git\s+-C\s+$/.test(segment)) return true;
  if (/(^|[\s(])make\s+-C\s+$/.test(segment)) return true;
  if (/(^|[\s(])terraform\s+-chdir(?:=|\s+)$/.test(segment)) return true;
  if (/(^|\s)(?:--cwd|--workdir|--directory)\s+$/.test(segment)) return true;
  return false;
}

function lastShellSeparatorIndex(value: string): number {
  return Math.max(value.lastIndexOf("\n"), value.lastIndexOf(";"), value.lastIndexOf("|"), value.lastIndexOf("&"));
}

function trimPathPunctuation(value: string): string {
  return value.replace(/^[=:]+/, "").replace(/[.:]+$/, "");
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[fn(k)] = mapStrings(v, fn);
    return out;
  }
  return value;
}

function maskJsonStringLiterals(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      out += " ";
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += " ";
      escaped = true;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    out += " ";
  }

  return out;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
}

/**
 * The subset of a request body that JSON-aware redaction can actually rewrite: the string leaves
 * (values + object keys) of a JSON document, joined by newlines, or the whole raw body when it is
 * not JSON. Detection should run over THIS text, not the raw body, so that "detected == redactable":
 * a value that appears only as a JSON *number* leaf (e.g. `{"card": 4111111111111111}`) is neither
 * detected nor rewritten, so it never trips the fail-closed leak gate. Numeric-primitive PII is a
 * documented limitation — a surrogate is a string and cannot replace a JSON number without changing
 * the leaf's type. Registered numeric secrets are unaffected: they enter the permanent vault
 * directly (not via detection) and the leak backstop still scans primitives for them.
 */
export function redactableBodyText(body: string): string {
  if (!body) return body;
  try {
    const strings: string[] = [];
    collectStrings(JSON.parse(body), strings);
    return strings.join("\n");
  } catch {
    return body; // non-JSON: the entire body is redactable text
  }
}
