// Heuristic pre-classification for the `ficta review` prompt: given an env var name and the literal
// value(s) it was discovered with, guess whether it is a secret worth redacting or benign config.
//
// SAFETY CONTRACT: values are inputs used only to compute the verdict. The return value is a closed
// union of fixed literals — no substring of any value may ever appear in the output, including on
// error paths. `new URL(...)` is wrapped so a value never leaks through a thrown message. This lets
// the review prompt pre-select a sensible default without ever rendering, storing, or hinting a value.
//
// Bias is fail-safe: when unsure, keep protecting. A false "keep" costs the user one extra checkbox;
// a false "un-protect" defaults a real secret to excluded.

export type NonSecretReason =
  | "well-known config name"
  | "looks like a URL (no credentials)"
  | "looks like a file/socket path"
  | "looks like a config setting";

export interface EnvClassification {
  verdict: "keep-protected" | "likely-non-secret";
  /** Present only for likely-non-secret. Always a fixed literal — never derived from a value. */
  reason?: NonSecretReason;
}

// Secret-ish name words, matched at underscore boundaries (stricter than the broad gather-side
// substring filter, so REGION/URL/PROFILE don't trip it). A hit forces keep-protected.
const SECRET_NAME =
  /(^|_)(KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|AUTH|BEARER|JWT|PRIVATE|SIGNING|CERT|SESSION|COOKIE|WEBHOOK|DSN|SALT|HASH)(_|$)/i;
const PII_NAME = /(^|_)(EMAIL|PHONE|SSN|ADDRESS|ACCOUNT|CARD|IBAN)S?(_|$)/i;

// Names that are well-known non-secret config, even when they contain a secret-ish word
// (e.g. SSH_AUTH_SOCK). Applied before SECRET_NAME; the value veto below still overrides.
const EXACT_ALLOWLIST = new Set(
  [
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_DEFAULT_OUTPUT",
    "AWS_PAGER",
    "AWS_SDK_LOAD_CONFIG",
    "AWS_EC2_METADATA_DISABLED",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "NODE_ENV",
    "LOG_LEVEL",
    "RUST_LOG",
    "NO_COLOR",
    "FORCE_COLOR",
    "TERM",
    "COLORTERM",
    "SHELL",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "LANG",
    "LC_ALL",
    "TZ",
  ].map((n) => n.toUpperCase()),
);

const PATTERN_ALLOWLIST = [/(^|_)LOG_LEVEL$/i, /_PROMPT(_|$)/i, /(^|_)(REGION|PORT|TIMEOUT|TIMEOUT_MS)$/i];

function isAllowlistedName(name: string): boolean {
  if (EXACT_ALLOWLIST.has(name.toUpperCase())) return true;
  return PATTERN_ALLOWLIST.some((re) => re.test(name));
}

// A credential embedded in a query string, e.g. a pre-signed URL: ...?sig=..., &token=..., &sas=...
const CRED_QUERY_PARAM =
  /[?&](api[_-]?key|token|access[_-]?token|secret|password|passwd|sig|signature|sas|client[_-]?secret|auth)=/i;

// Recognizable secret token shapes regardless of name.
const KNOWN_TOKEN_PREFIX = /(^|[^A-Za-z0-9])(sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[baprs]-|AKIA[A-Z0-9]{8}|eyJ)/;

// Explicit path/URI prefixes only — never "contains a slash" (base64 also does).
const EXPLICIT_PATH = /^(\/|~\/|\.\/|\.\.\/|file:\/\/|[A-Za-z]:\\)/;

// Booleans, log levels, common env names, and short numbers (capped so 8+-digit phone-shaped
// numbers never classify as non-secret).
const BOOL_ENUM_NUM =
  /^(true|false|yes|no|on|off|enabled|disabled|null|none|\d{1,6}|debug|info|warn|warning|error|trace|silent|verbose|fatal|development|production|staging|local|dev|prod|test)$/i;

// A dictionary-ish slug: letters/digits with word separators, e.g. eu-central-1-prod. Length-capped.
const WORD_SLUG = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/i;

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Longest contiguous alphanumeric run — separators split it, so slugs/paths score their words. */
function longestAlnumRun(value: string): string {
  let longest = "";
  for (const run of value.split(/[^A-Za-z0-9]+/)) {
    if (run.length > longest.length) longest = run;
  }
  return longest;
}

/**
 * Does this value look like random/high-entropy secret material? Operates on the longest alphanumeric
 * run so a structured slug like `eu-central-1-prod` (longest word 7 chars) never trips, while a bare
 * 16-hex token or a 32-char base64 blob does.
 */
export function looksHighEntropy(value: string): boolean {
  if (KNOWN_TOKEN_PREFIX.test(value)) return true;
  const run = longestAlnumRun(value);
  if (/^[0-9a-f]{24,}$/i.test(run)) return true;
  if (run.length >= 32) return shannonEntropy(run) >= 3.0;
  if (run.length >= 16) return shannonEntropy(run) >= 3.5;
  return false;
}

function hasUrlUserinfo(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
}

/** Any value shaped like credential material forces keep-protected, overriding every name rule. */
function isCredentialShaped(value: string): boolean {
  return hasUrlUserinfo(value) || CRED_QUERY_PARAM.test(value) || looksHighEntropy(value);
}

function isCredentialFreeUrl(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** Non-secret shape of a single value (already known not to be credential-shaped), or undefined. */
function nonSecretValueShape(value: string): NonSecretReason | undefined {
  if (isCredentialFreeUrl(value)) return "looks like a URL (no credentials)";
  if (EXPLICIT_PATH.test(value)) return "looks like a file/socket path";
  if (BOOL_ENUM_NUM.test(value) || (value.length <= 32 && WORD_SLUG.test(value))) {
    return "looks like a config setting";
  }
  return undefined;
}

/**
 * Classify an env var by name plus every literal it was discovered with (one name can appear across
 * .env files, process env, and doppler). Precedence:
 *   1. Any credential-shaped value → keep (a secret in a benign-named var is never pre-unchecked).
 *   2. Well-known config name → likely-non-secret.
 *   3. Secret/PII name word → keep.
 *   4. Every value has a benign shape (url/path/config) → likely-non-secret.
 *   5. Default → keep.
 */
export function classifyEnvCandidate(name: string, values: readonly string[]): EnvClassification {
  for (const value of values) {
    if (isCredentialShaped(value)) return { verdict: "keep-protected" };
  }

  if (isAllowlistedName(name)) return { verdict: "likely-non-secret", reason: "well-known config name" };

  if (SECRET_NAME.test(name) || PII_NAME.test(name)) return { verdict: "keep-protected" };

  if (values.length > 0) {
    let reason: NonSecretReason | undefined;
    let allBenign = true;
    for (const value of values) {
      const shape = nonSecretValueShape(value);
      if (!shape) {
        allBenign = false;
        break;
      }
      reason ??= shape;
    }
    if (allBenign && reason) return { verdict: "likely-non-secret", reason };
  }

  return { verdict: "keep-protected" };
}
