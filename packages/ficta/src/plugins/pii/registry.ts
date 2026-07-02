import { presidioRecognizer } from "./presidio-recognizer.js";
import type { PiiRecognizer } from "./recognizer.js";
import { regexRecognizer } from "./regex-recognizer.js";

/** Env selecting the single PII detection backend (TOML: [pii] backend). */
export const ENV_BACKEND = "FICTA_PII_BACKEND";

/** Always-available in-process default; also the safety floor if a networked backend is unreachable. */
export const DEFAULT_BACKEND = "regex";

/**
 * PII detection backends, keyed by config name — the plugin registry behind the `pii` feature.
 * Exactly one is selected at a time ([pii] backend); adding a backend (AWS Comprehend, Azure, spaCy)
 * is one entry here + its {@link PiiRecognizer} module.
 */
const BUILT_IN: Readonly<Record<string, PiiRecognizer>> = {
  regex: regexRecognizer,
  presidio: presidioRecognizer,
};

export interface BackendSelection {
  /** The effective backend name actually used (falls back to `regex` for an unknown config value). */
  name: string;
  /** The selected recognizer. */
  backend: PiiRecognizer;
  /** A configured name that did not resolve to a built-in backend (reported; regex is used instead). */
  unknown?: string;
}

/** The configured backend name (lowercased). Defaults to `regex` when unset/blank. */
export function selectedBackendName(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV_BACKEND]?.trim().toLowerCase() || DEFAULT_BACKEND;
}

/** Resolve the configured backend to a recognizer; an unknown name safely degrades to regex. */
export function activeBackend(env: NodeJS.ProcessEnv = process.env): BackendSelection {
  const name = selectedBackendName(env);
  const backend = BUILT_IN[name];
  if (backend) return { name, backend };
  return { name: DEFAULT_BACKEND, backend: regexRecognizer, unknown: name };
}

/** Names of the backends ficta knows how to build — for diagnostics and setup. */
export function builtInBackendNames(): string[] {
  return Object.keys(BUILT_IN);
}
