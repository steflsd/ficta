import { accessSync, constants, existsSync } from "node:fs";
import { configuredUpstreamPolicyIssues, loadConfig } from "./config.js";
import { applyRuntimeEnvDefaults } from "./defaults.js";
import { globalDisablePath, isGloballyDisabled } from "./global-disable.js";
import { defaultShimDir, findExecutable } from "./install.js";
import { codexUsesChatgptAuth } from "./plugins/agents.js";
import {
  type AgentIntegration,
  agentIntegrations,
  loadPluginRegistry,
  type PluginDiscovery,
  registryDiscoveryLines,
} from "./plugins/index.js";
import { configPath } from "./user-config.js";

export interface DoctorOptions {
  /** Optional agent command to check strictly, e.g. claude/codex/pi. */
  agent?: string;
}

export interface DoctorReport {
  config: {
    configPath?: string;
    configExists: boolean;
    failClosed: boolean;
    logBodies: boolean;
    redactPaths: boolean;
    requireRegistry: boolean;
    globallyDisabled: boolean;
    disablePath: string;
    upstreams: { anthropic: string; openai: string; chatgpt: string };
    forcedUpstream?: string;
    allowCustomUpstream: boolean;
  };
  registry: {
    protectedValues: number;
    discoveries: PluginDiscovery[];
  };
  agents: DoctorAgentReport[];
  issues: DoctorIssue[];
}

export interface DoctorAgentReport {
  command: string;
  label: string;
  selected: boolean;
  executable?: string;
  overrideEnv?: string;
  executableUsable?: boolean;
  route: string;
  status: "ok" | "warning" | "error";
  message: string;
}

export interface DoctorIssue {
  severity: "warning" | "error";
  message: string;
}

export function collectDoctorReport(opts: DoctorOptions = {}): DoctorReport {
  applyRuntimeEnvDefaults(process.env);

  const cfg = loadConfig();
  const globallyDisabled = isGloballyDisabled();
  const registry = loadPluginRegistry();
  const integrations = agentIntegrations();
  const selected = opts.agent ? integrations.find((agent) => agent.command === opts.agent) : undefined;
  const unknownAgent = Boolean(opts.agent && !selected);
  const agentsToCheck = selected ? [selected] : integrations;
  const issues: DoctorIssue[] = [];

  if (unknownAgent) issues.push({ severity: "error", message: `unknown agent: ${opts.agent}` });

  if (registry.values.length === 0) {
    issues.push({
      severity: process.env.FICTA_REQUIRE_REGISTRY === "1" ? "error" : "warning",
      message:
        process.env.FICTA_REQUIRE_REGISTRY === "1"
          ? "no protected values loaded, and FICTA_REQUIRE_REGISTRY=1 would block agent launch"
          : "no protected values loaded; ficta would launch in passthrough mode",
    });
  }

  if (process.env.FICTA_REQUIRE_REGISTRY === "1") {
    for (const discovery of registry.discoveries) {
      if (discovery.status === "error") {
        issues.push({
          severity: "error",
          message: `registry source ${discovery.label} reported an error in strict mode`,
        });
      }
    }
  }

  if (globallyDisabled) {
    issues.push({ severity: "warning", message: "ficta is globally disabled; run `ficta enable` to re-enable shims" });
  }

  if (!cfg.failClosed) {
    issues.push({ severity: "warning", message: "FICTA_FAIL_CLOSED=0 is set; leaks would be warned, not blocked" });
  }
  for (const upstreamIssue of configuredUpstreamPolicyIssues(cfg)) {
    issues.push({ severity: "error", message: upstreamIssue });
  }
  if (cfg.logBodies) {
    issues.push({ severity: "warning", message: "FICTA_LOG_BODIES=1 is set; raw model bodies may be written to disk" });
  }
  const path = configPath();
  if (!process.env.FICTA_SURROGATE_KEY) {
    issues.push({
      severity: "warning",
      message: path
        ? "no stable surrogate key is active yet; normal launch/install will generate one in ~/.ficta/config.toml"
        : "no stable surrogate key is active; FICTA_CONFIG_FILE=0 means launches use per-process surrogates unless FICTA_SURROGATE_KEY is set",
    });
  }

  const agentReports = agentsToCheck.map((agent) => doctorAgentReport(agent, Boolean(selected)));
  for (const agent of agentReports) {
    if (agent.status === "error") issues.push({ severity: "error", message: `${agent.command}: ${agent.message}` });
  }

  return {
    config: {
      configPath: path,
      configExists: Boolean(path && existsSync(path)),
      failClosed: cfg.failClosed,
      logBodies: cfg.logBodies,
      redactPaths: envFlag(process.env.FICTA_REDACT_PATHS),
      requireRegistry: process.env.FICTA_REQUIRE_REGISTRY === "1",
      globallyDisabled,
      disablePath: globalDisablePath(),
      upstreams: cfg.upstreams,
      forcedUpstream: cfg.forcedUpstream,
      allowCustomUpstream: cfg.allowCustomUpstream,
    },
    registry: {
      protectedValues: registry.values.length,
      discoveries: registry.discoveries,
    },
    agents: agentReports,
    issues,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("ficta doctor");
  lines.push("");

  lines.push("config");
  if (report.config.configPath) {
    lines.push(
      `  ${report.config.configExists ? "✓" : "-"} user config: ${report.config.configPath}${
        report.config.configExists ? "" : " (not found; defaults/env in use)"
      }`,
    );
  } else {
    lines.push("  - user config: disabled by FICTA_CONFIG_FILE=0");
  }
  lines.push(`  ${report.config.failClosed ? "✓" : "!"} fail-closed: ${report.config.failClosed ? "on" : "OFF"}`);
  lines.push(`  ${report.config.logBodies ? "!" : "✓"} raw body logs: ${report.config.logBodies ? "ON" : "off"}`);
  lines.push(
    `  ${report.config.redactPaths ? "!" : "-"} path-like tokens: ${
      report.config.redactPaths ? "redacted when matched" : "preserved by default"
    }`,
  );
  lines.push(
    `  ${report.config.requireRegistry ? "!" : "-"} require registry: ${report.config.requireRegistry ? "on" : "off"}`,
  );
  lines.push(
    `  ${report.config.globallyDisabled ? "!" : "✓"} global disable: ${
      report.config.globallyDisabled ? `ON (${report.config.disablePath})` : "off"
    }`,
  );
  lines.push("");

  lines.push("registry");
  lines.push(
    `  ${report.registry.protectedValues > 0 ? "✓" : "!"} protected values loaded: ${report.registry.protectedValues}`,
  );
  for (const line of registryDiscoveryLines(report.registry.discoveries, "  ")) lines.push(line);
  lines.push("");

  lines.push("agents");
  if (report.agents.length === 0) {
    lines.push("  ! no built-in agent integration matched");
  } else {
    for (const agent of report.agents) {
      const icon = agent.status === "ok" ? "✓" : agent.status === "error" ? "✗" : "!";
      lines.push(`  ${icon} ${agent.command} (${agent.label}): ${agent.message}`);
      lines.push(`      route: ${agent.route}`);
      if (agent.executable)
        lines.push(`      executable: ${agent.executable}${agent.overrideEnv ? ` (${agent.overrideEnv})` : ""}`);
    }
  }
  lines.push("");

  lines.push("upstreams");
  if (report.config.forcedUpstream) lines.push(`  ! forced upstream: ${report.config.forcedUpstream}`);
  if (report.config.allowCustomUpstream) lines.push("  ! custom upstreams: allowed by FICTA_ALLOW_CUSTOM_UPSTREAM=1");
  lines.push(`  anthropic: ${report.config.upstreams.anthropic}`);
  lines.push(`  openai:    ${report.config.upstreams.openai}`);
  lines.push(`  chatgpt:   ${report.config.upstreams.chatgpt}`);
  lines.push("");

  const errors = report.issues.filter((issue) => issue.severity === "error");
  const warnings = report.issues.filter((issue) => issue.severity === "warning");
  lines.push("summary");
  if (errors.length === 0 && warnings.length === 0) {
    lines.push("  ✓ no issues found");
  } else {
    for (const issue of errors) lines.push(`  ✗ ${issue.message}`);
    for (const issue of warnings) lines.push(`  ! ${issue.message}`);
  }

  return `${lines.join("\n")}\n`;
}

export function doctorExitCode(report: DoctorReport): number {
  return report.issues.some((issue) => issue.severity === "error") ? 1 : 0;
}

function doctorAgentReport(agent: AgentIntegration, selected: boolean): DoctorAgentReport {
  const overrideEnv = realAgentEnvName(agent.command);
  const override = process.env[overrideEnv];
  const executable = override || findExecutable(agent.command, { excludeDirs: shimDirs() });
  const executableUsable = executable ? isUsableExecutable(executable) : false;
  const route = routeSummary(agent.command);

  if (!executable) {
    return {
      command: agent.command,
      label: agent.label,
      selected,
      route,
      status: selected ? "error" : "warning",
      message: selected
        ? `real executable not found outside ${shimDirs().join(", ")}`
        : `not installed or not found outside ${shimDirs().join(", ")}`,
    };
  }

  if (override && !executableUsable) {
    return {
      command: agent.command,
      label: agent.label,
      selected,
      executable,
      overrideEnv,
      executableUsable,
      route,
      status: selected ? "error" : "warning",
      message: `${overrideEnv} is set but is not executable/readable`,
    };
  }

  return {
    command: agent.command,
    label: agent.label,
    selected,
    executable,
    overrideEnv: override ? overrideEnv : undefined,
    executableUsable,
    route,
    status: "ok",
    message: override ? `using ${overrideEnv}` : "found real executable",
  };
}

function realAgentEnvName(command: string): string {
  return `FICTA_REAL_${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function shimDirs(): string[] {
  return [defaultShimDir(), process.env.FICTA_SHIM_DIR].filter((v): v is string => Boolean(v));
}

function routeSummary(command: string): string {
  if (command === "claude") return "sets ANTHROPIC_BASE_URL to the ephemeral ficta proxy";
  if (command === "codex") {
    return codexUsesChatgptAuth(process.env)
      ? "injects Codex custom provider + chatgpt_base_url (ChatGPT/OAuth detected)"
      : "injects Codex custom provider for OpenAI-compatible traffic";
  }
  if (command === "pi") return "injects a temporary Pi extension overriding Anthropic/OpenAI base URLs";
  return "agent integration supplies launch environment";
}

function envFlag(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "enabled";
}

function isUsableExecutable(path: string): boolean {
  // If the override is a bare command name, spawn will resolve it through PATH at launch time.
  if (!path.includes("/")) return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
