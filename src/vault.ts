import { createHmac, randomBytes } from "node:crypto";

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

const SUR_PREFIX = "FICTA_";
const SUR_HEX_LEN = 32;
const SUR_LEN = SUR_PREFIX.length + SUR_HEX_LEN;
const SUR_RE = new RegExp(`${SUR_PREFIX}[0-9a-f]{${SUR_HEX_LEN}}`, "g");
const ENV_SURROGATE_KEY = process.env.FICTA_SURROGATE_KEY;
const SURROGATE_KEY = ENV_SURROGATE_KEY ?? randomBytes(32).toString("hex");

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

function surrogateFor(value: string): string {
  return SUR_PREFIX + createHmac("sha256", SURROGATE_KEY).update(value).digest("hex").slice(0, SUR_HEX_LEN);
}

export class Vault {
  private readonly values: string[] = []; // known values, longest first
  private readonly seen = new Set<string>();
  private readonly toSur = new Map<string, string>();
  private readonly toVal = new Map<string, string>();

  constructor(values: ReadonlyArray<VaultValue> = []) {
    this.register(values);
  }

  get size(): number {
    return this.values.length;
  }

  /**
   * Register additional values, e.g. from request-time detector plugins. The vault is name-blind, so
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
      const sur = surrogateFor(value);
      this.toSur.set(value, sur);
      this.toVal.set(sur, value);
      added++;
    }
    if (added > 0) this.values.sort((a, b) => b.length - a.length);
    return added;
  }

  /** Redact known values in a raw string. */
  redactText(text: string): { text: string; count: number } {
    if (this.size === 0 || !text) return { text, count: 0 };
    const found = new Set<string>();
    return { text: this.replaceKnown(text, found), count: found.size };
  }

  /**
   * Redact a request body. Parses JSON and replaces inside string leaves and object keys so
   * escaping stays correct; falls back to raw string replace for non-JSON. Returns the new body +
   * how many distinct known values were swapped out.
   */
  redactBody(body: string): { body: string; count: number } {
    if (this.size === 0 || !body) return { body, count: 0 };
    const found = new Set<string>();
    const replace = (s: string): string => this.replaceKnown(s, found);
    try {
      const mapped = mapStrings(JSON.parse(body), replace);
      return { body: found.size > 0 ? JSON.stringify(mapped) : body, count: found.size };
    } catch {
      return { body: replace(body), count: found.size };
    }
  }

  private replaceKnown(text: string, found: Set<string>): string {
    let out = text;
    for (const v of this.values) {
      if (!out.includes(v)) continue;
      const surrogate = this.toSur.get(v);
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
    if (this.toVal.size === 0 || !text) return text;
    return text.replace(SUR_RE, (m) => this.toVal.get(m) ?? m);
  }

  /**
   * Fail-closed gate: how many registered/detected values are still present in an
   * already-redacted outbound body/text. Must be 0 before we forward.
   */
  leakCount(body: string): number {
    if (this.size === 0 || !body) return 0;
    const strings: string[] = [];
    try {
      collectStrings(JSON.parse(body), strings);
    } catch {
      strings.push(body);
    }
    let n = 0;
    for (const v of this.values) if (strings.some((s) => containsKnownOutsidePaths(s, v))) n++;
    return n;
  }

  /**
   * A TransformStream that restores surrogates in a streamed response. Holds back a short tail
   * each chunk so a surrogate split across chunk boundaries is never emitted half-restored.
   */
  restoreStream(): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const HOLD = SUR_LEN - 1; // max partial surrogate; a full token is SUR_LEN chars
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
    return createSseRestoreStream((text) => this.restoreText(text), adapter);
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

export interface PendingSseFragment {
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
  adapter: SseRestoreAdapter,
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
        encode(restoreSseRecord(record, pending, restoreText, adapter), controller);
      }
    },
    flush(controller) {
      buf += decoder.decode();
      if (buf) encode(restoreSseRecord(buf, pending, restoreText, adapter), controller);
      encode(flushPendingSseFragments(pending, restoreText), controller);
    },
  });
}

function restoreSseRecord(
  record: string,
  pending: Map<string, PendingSseFragment>,
  restoreText: (text: string) => string,
  adapter: SseRestoreAdapter,
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
  if (fragments.length === 0) return prefix + restoreText(record);

  for (const fragment of fragments) {
    const combined = (pending.get(fragment.key)?.value ?? "") + fragment.value;
    const restored = restoreText(combined);
    const { emit, hold } = splitForPotentialSurrogate(restored);
    if (hold) pending.set(fragment.key, { value: hold, eventName: fragment.eventName, flushData: fragment.flushData });
    else pending.delete(fragment.key);
    fragment.setValue(emit);
  }

  return prefix + renderSseJsonRecord(parsed, data);
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

function splitForPotentialSurrogate(text: string): { emit: string; hold: string } {
  const max = Math.min(SUR_LEN - 1, text.length);
  for (let length = max; length > 0; length -= 1) {
    const suffix = text.slice(text.length - length);
    if (isPotentialSurrogatePrefix(suffix)) {
      return { emit: text.slice(0, text.length - length), hold: suffix };
    }
  }
  return { emit: text, hold: "" };
}

function isPotentialSurrogatePrefix(value: string): boolean {
  if (!value || value.length >= SUR_LEN) return false;
  if (SUR_PREFIX.startsWith(value)) return true;
  if (!value.startsWith(SUR_PREFIX)) return false;
  return /^[0-9a-f]*$/.test(value.slice(SUR_PREFIX.length));
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
  const lines = record.fields.filter((field) => field.name !== "data").map((field) => field.raw);
  lines.push(`data: ${JSON.stringify(data)}`);
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
  const raw = process.env.FICTA_REDACT_PATHS?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "enabled";
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
