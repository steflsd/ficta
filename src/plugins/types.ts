export type ProtectedValueKind = "secret" | "pii" | "custom";
export type ProtectionConfidence = "exact" | "high" | "probabilistic";

/** A concrete value ficta can reversibly surrogate. Values must never be logged. */
export interface ProtectedValue {
  /** Safe label for metadata/logging, e.g. env var name. Never the value. */
  name: string;
  /** The sensitive literal. Kept in memory only. */
  value: string;
  /** Safe source label, e.g. env-file, process-env, pii-detector. */
  source: string;
  /** Plugin that produced this value. Filled by the plugin manager if omitted. */
  plugin?: string;
  kind?: ProtectedValueKind;
  confidence?: ProtectionConfidence;
}

export interface DetectTextContext {
  surface: "body" | "header";
  /** Request path, if available. */
  path?: string;
  /** Header name for surface="header". */
  header?: string;
}

export type PluginDiscoveryStatus = "loaded" | "available" | "disabled" | "not_found" | "error";

/**
 * Safe launch-time discovery metadata. This is what the CLI/banner may print.
 * It must contain counts, names, paths, or instructions only — never protected values.
 */
export interface PluginDiscovery {
  /** Stable id for the discovered source, e.g. known-env-values/env-file. */
  id: string;
  /** Plugin that owns this source. */
  plugin: string;
  /** Human label shown in startup output. */
  label: string;
  status: PluginDiscoveryStatus;
  /** Number of values loaded from this source, if known. */
  valueCount?: number;
  /** Safe one-line explanation. */
  message?: string;
  /** Optional safe details, e.g. file names + counts. */
  details?: string[];
}

export interface AgentBypassContext {
  /** User-supplied args after the agent command and ficta-only flags were removed. */
  args: string[];
  /** Real executable resolved outside ~/.ficta/bin. */
  realExecutable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface AgentLaunchContext extends AgentBypassContext {
  /** Base ficta proxy URL, no trailing slash, e.g. http://127.0.0.1:8787. */
  baseUrl: string;
}

export interface AgentLaunchPlan {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Remove temporary config/extension files after the agent exits. */
  cleanup?: () => void | Promise<void>;
}

/** How to launch one AI coding client through ficta. */
export interface AgentIntegration {
  /** Stable id, e.g. builtin/claude. */
  id: string;
  /** Executable/shim command, e.g. claude, codex, pi. */
  command: string;
  label: string;
  description?: string;
  /** Return true for commands that do not call a model (e.g. --version, package management). */
  shouldBypass?(args: readonly string[]): boolean;
  /** Launch through ficta. */
  configureLaunch(ctx: AgentLaunchContext): AgentLaunchPlan;
  /** Optional dynamic cleanup for FICTA_DISABLE=1 bypasses, e.g. neutralizing stale persisted config. */
  configureBypass?(ctx: AgentBypassContext): AgentLaunchPlan;
}

/**
 * Narrow plugin seam: plugins only discover/load values, detect spans, or describe agent launch
 * integration. The core vault owns replacement, fail-closed leak checks, and restore, so plugins
 * cannot bypass the privacy invariant.
 */
export interface FictaPlugin {
  name: string;
  description?: string;

  /** Safe launch-time source discovery/status, printed before the agent starts. */
  discover?(): readonly PluginDiscovery[];

  /** Load exact registered values at startup (strongest exact-match layer). */
  loadValues?(): readonly ProtectedValue[];

  /** Detect values in a request body/header before redaction (for PII/pattern plugins). */
  detectText?(text: string, ctx: DetectTextContext): readonly ProtectedValue[];

  /** Agent/client integrations that know how to point a CLI at the local ficta proxy. */
  agents?: readonly AgentIntegration[];
}
