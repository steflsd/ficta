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

  /** Register additional values, e.g. from request-time detector plugins. */
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
