import { envFlag } from "./env-flags.js";

/**
 * Core-owned fail-closed policy for detector outages. A detector only *signals* that its backend
 * could not run (throwing `DetectorUnavailableError`) and *exposes* its own `failClosed()` override;
 * this module decides whether an outage blocks the request.
 *
 * Resolution is `perPluginOverride ?? globalDetectionFailClosed()`: the per-detector setting (e.g.
 * `[pii] fail_closed`) wins when set, otherwise the global default `FICTA_FAIL_CLOSED_DETECTION`
 * (default off) applies. This is separate from `FICTA_FAIL_CLOSED`, which blocks on *registered-secret*
 * leaks — a different condition with a different (on) default.
 */

/** Global default: block the request when a detector backend can't run. Default false (best-effort). */
export function globalDetectionFailClosed(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env.FICTA_FAIL_CLOSED_DETECTION);
}

/** Effective policy for one detector: its override if set, else the global default. */
export function detectorFailClosed(override: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return override ?? globalDetectionFailClosed(env);
}
