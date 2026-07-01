import { createHmac, randomBytes } from "node:crypto";
import type { ProtectedValue } from "./plugins/index.js";

/**
 * How a value becomes a surrogate token, and how tokens are recognized on the way back — the seam
 * that lets the token *format* be swapped (opaque `FICTA_<hex>` today; realistic, per-kind
 * surrogates later, to preserve model fluency) without touching the vault's replace/restore/
 * streaming mechanics.
 *
 * A strategy MUST be deterministic (same value → same token within a run) and its tokens MUST be
 * JSON-safe and matchable by `pattern`, or streaming restore will break.
 */
export interface SurrogateStrategy {
  /** Deterministically mint the surrogate token for a value. `kind` is advisory (unused today). */
  mint(value: string, kind?: ProtectedValue["kind"]): string;
  /** Global regex matching one complete surrogate token; used to scan text/JSON on restore. */
  readonly pattern: RegExp;
  /** Upper bound on a token's length; used for streaming hold-back at chunk/fragment edges. */
  readonly maxLength: number;
  /** Whether `text` could be the leading fragment of a not-yet-complete surrogate token. */
  isPotentialPrefix(text: string): boolean;
}

const HEX_PREFIX = "FICTA_";
const HEX_LEN = 32;
const HEX_TOTAL = HEX_PREFIX.length + HEX_LEN;

const ENV_SURROGATE_KEY = process.env.FICTA_SURROGATE_KEY;
// One key per process by default (same value → same surrogate across turns). Set
// FICTA_SURROGATE_KEY for cross-restart stability.
const DEFAULT_KEY = ENV_SURROGATE_KEY ?? randomBytes(32).toString("hex");

/** The built-in strategy: `FICTA_` + 32 hex chars of HMAC-SHA256(value) — opaque and JSON-safe. */
export function hexSurrogateStrategy(key: string = DEFAULT_KEY): SurrogateStrategy {
  return {
    mint(value) {
      return HEX_PREFIX + createHmac("sha256", key).update(value).digest("hex").slice(0, HEX_LEN);
    },
    pattern: new RegExp(`${HEX_PREFIX}[0-9a-f]{${HEX_LEN}}`, "g"),
    maxLength: HEX_TOTAL,
    isPotentialPrefix(text) {
      if (!text || text.length >= HEX_TOTAL) return false;
      if (HEX_PREFIX.startsWith(text)) return true;
      if (!text.startsWith(HEX_PREFIX)) return false;
      return /^[0-9a-f]*$/.test(text.slice(HEX_PREFIX.length));
    },
  };
}
