/**
 * Single source of truth for parsing boolean-ish env/config strings. Previously every flag had its
 * own ad-hoc parser and they had drifted: some accepted "yes"/"no"/"off"/"disabled" and some did
 * not, so the same value (e.g. FICTA_REDACT_PATHS=yes) was read as ON in one place and OFF in
 * another. Security-relevant flags must not depend on which parser happened to read them.
 */

const TRUTHY = new Set(["1", "true", "on", "enabled", "yes"]);
const FALSY = new Set(["0", "false", "off", "disabled", "no"]);

/** Parse a boolean-ish value. Returns undefined for unset/blank/unrecognized input. */
export function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return undefined;
}

/** A flag that defaults to off: true only for an explicit truthy value. */
export function envFlag(value: string | undefined): boolean {
  return parseBoolean(value) === true;
}

/** A flag with an explicit fallback used for unset/unrecognized values. */
export function envEnabled(value: string | undefined, fallback: boolean): boolean {
  return parseBoolean(value) ?? fallback;
}
