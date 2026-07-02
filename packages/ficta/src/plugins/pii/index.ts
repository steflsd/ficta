import { detectorFailClosed } from "../../detection-policy.js";
import { envFlag, parseBoolean } from "../../env-flags.js";
import { log } from "../../logger.js";
import { DetectorUnavailableError } from "../../redaction-engine.js";
import type { DetectorPlugin, PluginDiscovery } from "../types.js";
import { PresidioUnavailableError, presidioConfig } from "./presidio-recognizer.js";
import { activeBackend, ENV_BACKEND } from "./registry.js";

const PLUGIN_NAME = "pii";
const ENV_ENABLED = "FICTA_PII_ENABLED";
const ENV_AGENTS = "FICTA_PII_AGENTS";
const ENV_FAIL_CLOSED = "FICTA_PII_FAIL_CLOSED";

/**
 * A single detection backend is selected at a time — `FICTA_PII_BACKEND` ↔ `[pii] backend` (default
 * `regex`); see {@link activeBackend}. The in-process `regex` backend (sync) is the always-available
 * default; a `presidio` backend (async Microsoft Presidio sidecar for names/addresses/orgs) plugs in
 * behind {@link import("./recognizer.js").PiiRecognizer}. The engine's detection path is async, so
 * `detectText` awaits the backend (sync or async). The selected backend is the ONLY backend — there
 * is no cross-backend fallback. If it cannot run, `detectText` throws a neutral
 * {@link DetectorUnavailableError}; the *core* decides whether that blocks the request (resolving
 * this plugin's {@link piiFailClosed} override against the global default). The plugin never enforces.
 */

/** Exported so `ficta doctor` can gate its presidio reachability check on PII actually being on. */
export function piiEnabled(): boolean {
  return envFlag(process.env[ENV_ENABLED]);
}

/**
 * The user's per-detector fail-closed *override* (`[pii] fail_closed`), exposed for the core resolver
 * and `ficta doctor`. Tri-state: `true`/`false` force the policy, `undefined` (unset) defers to the
 * global `FICTA_FAIL_CLOSED_DETECTION` default. This only reports config — the core enforces it.
 * Independent of `FICTA_FAIL_CLOSED`, which guards *registered* secret leaks.
 */
export function piiFailClosed(): boolean | undefined {
  return parseBoolean(process.env[ENV_FAIL_CLOSED]);
}

/**
 * Per-surface PII gate for a launched coding agent (`ficta claude|codex|pi`). The web/standalone
 * proxy keeps the plain `[pii] enabled` posture; agent launches default *off* even when that is on,
 * because tokenizing an email inside code you're editing is rarely wanted. Precedence, highest first:
 *   1. An explicit shell `FICTA_PII_ENABLED` (captured before TOML is merged) wins either way — the
 *      documented "flip it for a single run" escape hatch. An unparseable value falls through.
 *   2. Otherwise on iff both `[pii] enabled` AND `[pii] agents` are true, so `enabled = false` stays a
 *      single kill switch and `agents = true` alone (with enabled off) is a no-op.
 * The engine and every downstream consumer read `FICTA_PII_ENABLED` at request time, so cli.ts forces
 * that one var from this result before the proxy loads — no per-engine plumbing needed.
 */
export function resolveAgentPiiEnabled(opts: { shellValue?: string; enabled?: string; agents?: string }): boolean {
  const explicit = parseBoolean(opts.shellValue);
  if (explicit !== undefined) return explicit;
  return envFlag(opts.enabled) && envFlag(opts.agents);
}

interface RecognizerFailure {
  reason: string;
  detail?: string;
  count: number;
}

// A recognizer backend being down is best-effort-degraded, not fatal: record the last failure per
// recognizer (safe metadata only) for discover()/doctor, and throttle the warning per recognizer+reason
// so a dead sidecar does not spam every request. Never logs values or request text.
const recognizerFailures = new Map<string, RecognizerFailure>();
// Epoch-ms of the last warning per recognizer+reason. We re-warn once the interval elapses instead of
// warning only once forever, so a sidecar that stays down keeps surfacing in logs (and the operator is
// not misled into thinking a single startup warning was transient).
const lastWarnedAt = new Map<string, number>();
const RE_WARN_INTERVAL_MS = 5 * 60 * 1000;

function notePiiRecognizerFailure(name: string, err: unknown): { reason: string; detail?: string } {
  const classified = classifyRecognizerFailure(err);
  const { reason, detail } = classified;
  const count = (recognizerFailures.get(name)?.count ?? 0) + 1;
  recognizerFailures.set(name, { reason, detail, count });

  const warnKey = `${name}:${reason}`;
  const now = Date.now();
  const previous = lastWarnedAt.get(warnKey);
  if (previous !== undefined && now - previous < RE_WARN_INTERVAL_MS) return classified;
  const firstWarning = previous === undefined;
  lastWarnedAt.set(warnKey, now);

  const suffix = detail ? ` (${detail})` : "";
  // Neutral wording: the plugin does not know the resolved fail-open/closed policy (core owns that).
  // pino gates this at warn; the interval throttle above keeps a dead sidecar from spamming every
  // request while still re-surfacing an ongoing outage. Re-warns carry the running failure count.
  const message = firstWarning
    ? `pii backend "${name}" unavailable — ${reason}${suffix}. Run \`ficta doctor\` to diagnose.`
    : `pii backend "${name}" still unavailable — ${reason}${suffix}; ${count} failures since first seen. Run \`ficta doctor\` to diagnose.`;
  log.warn({ backend: name, reason, ...(detail ? { detail } : {}), count }, message);
  return classified;
}

function classifyRecognizerFailure(err: unknown): { reason: string; detail?: string } {
  if (err instanceof PresidioUnavailableError) return { reason: err.reason, detail: err.detail };
  return { reason: "error", detail: err instanceof Error ? err.name : undefined };
}

/** Snapshot of the last recorded failure per recognizer (safe metadata) — for discover()/tests. */
export function piiRecognizerFailures(): Map<string, RecognizerFailure> {
  return new Map(recognizerFailures);
}

export function resetPiiRecognizerStateForTests(): void {
  recognizerFailures.clear();
  lastWarnedAt.clear();
}

/**
 * Best-effort PII detection, off by default. Detected values are tokenized on egress and restored
 * on responses exactly like a registered secret — but detection is a *reduction*, never a guarantee
 * (see docs/threat-model). Self-gates on its own config flag; the core never adds/removes plugins.
 */
export const piiPlugin: DetectorPlugin = {
  kind: "detector",
  name: PLUGIN_NAME,
  description:
    "Best-effort PII detection (regex + optional Microsoft Presidio sidecar), tokenized like any protected value",
  config: {
    envDefaults: {
      [ENV_ENABLED]: "0",
      [ENV_AGENTS]: "0",
      [ENV_FAIL_CLOSED]: "0",
      FICTA_PII_BACKEND: "regex",
      FICTA_PII_PRESIDIO_URL: "http://127.0.0.1:5002",
      FICTA_PII_PRESIDIO_LANGUAGE: "en",
      FICTA_PII_PRESIDIO_SCORE_THRESHOLD: "0.5",
      FICTA_PII_PRESIDIO_ENTITIES: "",
      FICTA_PII_PRESIDIO_TIMEOUT_MS: "1500",
    },
    bindings: [
      { env: ENV_ENABLED, path: ["pii", "enabled"], kind: "boolean" },
      { env: ENV_AGENTS, path: ["pii", "agents"], kind: "boolean" },
      { env: ENV_FAIL_CLOSED, path: ["pii", "fail_closed"], kind: "boolean" },
      { env: ENV_BACKEND, path: ["pii", "backend"], kind: "string" },
      { env: "FICTA_PII_PRESIDIO_URL", path: ["pii", "presidio", "url"], kind: "string" },
      { env: "FICTA_PII_PRESIDIO_LANGUAGE", path: ["pii", "presidio", "language"], kind: "string" },
      { env: "FICTA_PII_PRESIDIO_SCORE_THRESHOLD", path: ["pii", "presidio", "score_threshold"], kind: "number" },
      { env: "FICTA_PII_PRESIDIO_ENTITIES", path: ["pii", "presidio", "entities"], kind: "string-array-comma" },
      { env: "FICTA_PII_PRESIDIO_TIMEOUT_MS", path: ["pii", "presidio", "timeout_ms"], kind: "number" },
    ],
    sections: [
      { path: ["pii"], keys: ["enabled", "agents", "fail_closed", "backend"] },
      { path: ["pii", "presidio"], keys: ["url", "language", "score_threshold", "entities", "timeout_ms"] },
    ],
  },
  setup: {
    registrySources: () => [
      {
        id: `${PLUGIN_NAME}/detector`,
        label:
          "PII detection — best-effort redaction of emails, SSNs, and card numbers for the web/standalone proxy (off by default; coding-agent launches opt in separately via pii.agents)",
        defaultEnabled: piiEnabled(),
        enabledValues: () => ({ [ENV_ENABLED]: "1" }),
        disabledValues: () => ({ [ENV_ENABLED]: "0" }),
      },
    ],
  },
  discover: () => [discoverPii()],
  // Exposes the user's per-detector override; the core resolves it against the global default.
  failClosed: piiFailClosed,
  async detectText(text, ctx) {
    if (!text || !piiEnabled()) return [];
    const { name, backend } = activeBackend();
    try {
      // The backend may be sync (regex) or async (a Presidio/NER sidecar); await normalizes both.
      return [...(await backend.detect(text, ctx))];
    } catch (err) {
      // The selected backend is the only backend — no cross-backend fallback. Record the failure
      // (warn-once) and signal it neutrally; the core decides whether the outage blocks the request.
      const { reason, detail } = notePiiRecognizerFailure(name, err);
      throw new DetectorUnavailableError(PLUGIN_NAME, detail ? `${reason} (${detail})` : reason);
    }
  },
};

function discoverPii(): PluginDiscovery {
  const enabled = piiEnabled();
  if (!enabled) {
    return {
      id: `${PLUGIN_NAME}/detector`,
      plugin: PLUGIN_NAME,
      label: "PII detector",
      status: "disabled",
      message: `disabled — set ${ENV_ENABLED}=1 (pii.enabled=true) for the web/standalone proxy; coding-agent launches also need ${ENV_AGENTS}=1 (pii.agents=true)`,
    };
  }

  const { name, unknown } = activeBackend();
  const backendLabel = name === "presidio" ? `presidio (${presidioConfig().url})` : name;
  const onFailure = detectorFailClosed(piiFailClosed()) ? "block request" : "skip detection";

  const details: string[] = [];
  if (unknown) details.push(`unknown backend "${unknown}" — using ${name}`);
  for (const [failedName, failure] of piiRecognizerFailures()) {
    details.push(
      `${failedName}: last request failed — ${failure.reason}${failure.detail ? ` (${failure.detail})` : ""}`,
    );
  }

  return {
    id: `${PLUGIN_NAME}/detector`,
    plugin: PLUGIN_NAME,
    label: "PII detector",
    // A detector holds no pre-loaded values — it matches each request at runtime — so report `active`
    // with no valueCount rather than a misleading "(0 values)" that reads as idle.
    status: "active",
    message: `active — matches each request; backend: ${backendLabel}; on backend failure: ${onFailure}; tokenized on egress and restored on responses`,
    details: details.length > 0 ? details : undefined,
  };
}
