// ficta <agent> [args...]
// Starts an ephemeral redaction proxy and launches the agent pointed at it.
// `ficta install` adds shell shims so users can keep typing `claude` / `codex` / `pi`.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeAgentEnv } from "./child-env.js";
import { applyRuntimeEnvDefaults } from "./defaults.js";
import { envFlag } from "./env-flags.js";
import { isGloballyDisabled, setGlobalDisabled } from "./global-disable.js";
import { defaultShimDir, findExecutable, installShims, uninstallShims } from "./install.js";
import { agentCommands, findAgentIntegration } from "./plugins/index.js";
import { renderStartupBanner } from "./startup-banner.js";
import { ensureSurrogateKey, loadUserConfig } from "./user-config.js";

loadUserConfig();

const args = process.argv.slice(2);
const command = args[0];
const supportedAgents = agentCommands();

if (command === "-v" || command === "--version" || command === "version") {
  process.stdout.write(`${renderVersion()}\n`);
  process.exit(0);
}

if (command === "-h" || command === "--help" || command === undefined) {
  printHelp(command === undefined ? 2 : 0);
}

if (command === "setup") {
  const { runSetup } = await import("./setup.js");
  await runSetup({ supportedAgents });
  process.exit(0);
}

if (command === "install") {
  const result = installShims({
    agents: supportedAgents,
    force: args.includes("--force"),
    updateShell: !args.includes("--no-shell"),
  });
  process.stderr.write(`✓ ficta shim dir: ${result.shimDir}\n`);
  if (result.launcher.status === "skipped-existing") {
    process.stderr.write(`! skipped existing non-ficta launcher: ${result.launcher.path}\n`);
  } else {
    process.stderr.write(`✓ ${result.launcher.status} ficta launcher: ${result.launcher.path}\n`);
  }
  for (const shim of result.shims) {
    const suffix = shim.realAgent ? ` (real ${shim.agent}: ${shim.realAgent})` : " (real agent not found yet)";
    if (shim.status === "skipped-existing") process.stderr.write(`! skipped existing non-ficta file: ${shim.path}\n`);
    else if (shim.status === "skipped-launcher")
      process.stderr.write(`! skipped ${shim.agent} shim because launcher was not installed: ${shim.path}\n`);
    else process.stderr.write(`✓ ${shim.status} ${shim.agent} shim: ${shim.path}${suffix}\n`);
  }
  if (result.rcPath) {
    if (result.pathUpdated) process.stderr.write(`✓ added ${result.shimDir} to PATH in ${result.rcPath}\n`);
    else if (result.pathAlreadyConfigured) process.stderr.write(`✓ PATH already configured in ${result.rcPath}\n`);
  }
  const keyResult = ensureSurrogateKey();
  process.stderr.write(
    keyResult.generated
      ? `✓ generated a stable surrogate key in ${keyResult.path} (0600, never printed)\n`
      : "✓ stable surrogate key already configured\n",
  );
  process.stderr.write(
    `\nRestart your shell, then run:\n  ${supportedAgents.join("\n  ")}\n\nBypass once with: FICTA_DISABLE=1 ${supportedAgents[0] ?? "claude"}\nDisable globally with: ficta disable\n`,
  );
  process.exit(
    result.launcher.status === "skipped-existing" ||
      result.shims.some((s) => s.status === "skipped-existing" || s.status === "skipped-launcher")
      ? 1
      : 0,
  );
}

if (command === "uninstall") {
  const result = uninstallShims({ agents: supportedAgents, updateShell: !args.includes("--no-shell") });
  for (const shim of result.shims) {
    if (shim.status === "removed") process.stderr.write(`✓ removed ${shim.agent} shim: ${shim.path}\n`);
    else if (shim.status === "missing") process.stderr.write(`- missing ${shim.agent} shim: ${shim.path}\n`);
    else process.stderr.write(`! skipped non-ficta file: ${shim.path}\n`);
  }
  if (result.launcher.status === "removed") process.stderr.write(`✓ removed ficta launcher: ${result.launcher.path}\n`);
  else if (result.launcher.status === "missing")
    process.stderr.write(`- missing ficta launcher: ${result.launcher.path}\n`);
  else process.stderr.write(`! skipped non-ficta launcher: ${result.launcher.path}\n`);
  if (result.rcPath) {
    process.stderr.write(`${result.pathBlockRemoved ? "✓ removed" : "- no"} PATH block in ${result.rcPath}\n`);
  }
  process.exit(
    result.launcher.status === "skipped-not-ficta" || result.shims.some((s) => s.status === "skipped-not-ficta")
      ? 1
      : 0,
  );
}

if (command === "disable") {
  const result = setGlobalDisabled(true);
  process.stderr.write(
    result.changed
      ? `✓ ficta disabled globally: ${result.path}\n`
      : `- ficta already disabled globally: ${result.path}\n`,
  );
  process.stderr.write("Agent shims will bypass ficta until you run: ficta enable\n");
  process.exit(0);
}

if (command === "enable") {
  const result = setGlobalDisabled(false);
  process.stderr.write(
    result.changed
      ? `✓ ficta enabled globally (removed ${result.path})\n`
      : `- ficta already enabled globally: ${result.path} not present\n`,
  );
  process.exit(0);
}

if (command === "doctor") {
  const { collectDoctorReport, doctorExitCode, renderDoctorReport } = await import("./doctor.js");
  const report = collectDoctorReport({ agent: args[1] });
  process.stderr.write(renderDoctorReport(report));
  process.exit(doctorExitCode(report));
}

const agent = findAgentIntegration(command);
if (!agent) printHelp(2);
const { rest, allowEmpty, verbose } = extractFictaFlags(args.slice(1));

// Escape hatch for installed shims: run the real agent without starting ficta.
const disableReason =
  process.env.FICTA_DISABLE === "1"
    ? "FICTA_DISABLE=1"
    : isGloballyDisabled()
      ? "global disable is active; run `ficta enable` to re-enable"
      : undefined;
if (disableReason) {
  const agentPath = resolveAgentExecutable(agent.command);
  if (!agentPath) {
    process.stderr.write(`ficta: disabled but could not find real ${agent.command} outside the shim dir\n`);
    process.exit(127);
  }
  const env = sanitizeAgentEnv(process.env);
  const plan = agent.configureBypass?.({ args: rest, realExecutable: agentPath, env, cwd: process.cwd() }) ?? {
    executable: agentPath,
    args: rest,
    env,
  };
  process.stderr.write(`ficta disabled (${disableReason}) — launching ${plan.executable}\n`);
  const code = await runChild(spawn(plan.executable, plan.args, { stdio: "inherit", env: plan.env }));
  await plan.cleanup?.();
  process.exit(code);
}

// Some agent subcommands (help/version/package management) do not call a model. Do not require a
// loaded registry or start a proxy for those; just delegate to the real executable.
if (agent.shouldBypass?.(rest)) {
  const agentPath = resolveAgentExecutable(agent.command);
  if (!agentPath) {
    process.stderr.write(`ficta: could not find real ${agent.command} outside the shim dir\n`);
    process.exit(127);
  }
  process.exit(await runChild(spawn(agentPath, rest, { stdio: "inherit", env: sanitizeAgentEnv(process.env) })));
}

// Sensible defaults BEFORE the proxy module loads (it reads these at import).
applyRuntimeEnvDefaults(process.env);
process.env.FICTA_SILENT ??= "1"; // keep the terminal clean for the agent

// Stable surrogates by default for every entry path — generate/persist a local key if absent,
// before the vault module reads FICTA_SURROGATE_KEY at import.
const surrogate = ensureSurrogateKey();
if (surrogate.generated) {
  process.stderr.write(`🔑 ficta — generated a stable surrogate key (${surrogate.path}, 0600)\n`);
}

const { startProxy } = await import("./server.js");
const { surrogateKeyWarning } = await import("./vault.js");
const proxy = await startProxy({ port: 0 });
const base = `http://127.0.0.1:${proxy.port}`;

process.stderr.write(
  renderStartupBanner({
    protectedValues: proxy.protectedValues,
    agentCommand: agent.command,
    baseUrl: base,
    discoveries: proxy.registry,
    policyExcluded: proxy.policyExcluded,
    policyExcludedBySource: proxy.policyExcludedBySource,
    registryPolicy: proxy.registryPolicy,
    verbose: verbose || envFlag(process.env.FICTA_VERBOSE),
  }),
);

const strictRegistry =
  process.env.FICTA_REQUIRE_REGISTRY === "1" && !allowEmpty && process.env.FICTA_ALLOW_EMPTY !== "1";
if (strictRegistry && proxy.registry.some((discovery) => discovery.status === "error")) {
  process.stderr.write(
    "\n🛑 ficta registry source error(s) were reported and FICTA_REQUIRE_REGISTRY=1 is set.\n" +
      "   Run `ficta doctor` or disable/fix the failing source before launching.\n",
  );
  proxy.close();
  process.exit(2);
}

if (proxy.protectedValues === 0 && strictRegistry) {
  process.stderr.write(
    "\n🛑 ficta found no protected values and FICTA_REQUIRE_REGISTRY=1 is set.\n" +
      "   Add .env values, configure a registry source, run `ficta setup`,\n" +
      "   or bypass strict mode with --allow-empty / FICTA_ALLOW_EMPTY=1.\n",
  );
  proxy.close();
  process.exit(2);
}

if (proxy.protectedValues === 0) {
  process.stderr.write(
    "   ⚠ no protected values loaded — launching anyway in passthrough mode; set FICTA_REQUIRE_REGISTRY=1 to block instead\n",
  );
}
const keyWarning = surrogateKeyWarning();
if (keyWarning) process.stderr.write(`   ⚠ ${keyWarning}\n`);

const agentPath = resolveAgentExecutable(agent.command);
if (!agentPath) {
  process.stderr.write(
    `ficta: failed to find real ${agent.command} outside ${process.env.FICTA_SHIM_DIR ?? defaultShimDir()}\n`,
  );
  proxy.close();
  process.exit(127);
}

const plan = agent.configureLaunch({
  baseUrl: base,
  args: rest,
  realExecutable: agentPath,
  env: sanitizeAgentEnv(process.env),
  cwd: process.cwd(),
});

const child = spawn(plan.executable, plan.args, { stdio: "inherit", env: plan.env });

let cleaned = false;
const shutdown = async () => {
  process.stderr.write(`\n🔒 ficta — kept ${proxy.keptCount()} protected value(s) out of the model this session\n`);
  proxy.close();
  if (!cleaned) {
    cleaned = true;
    await plan.cleanup?.();
  }
};
child.on("exit", async (code) => {
  await shutdown();
  process.exit(code ?? 0);
});
child.on("error", async (e) => {
  process.stderr.write(`ficta: failed to launch ${agent.command}: ${(e as Error).message}\n`);
  await shutdown();
  process.exit(1);
});

function printHelp(exitCode: number): never {
  const agents = supportedAgents.length > 0 ? supportedAgents.join(", ") : "agent";
  const help = [
    "ficta — keep your registered secrets out of the LLM",
    "",
    "Usage:",
    "  ficta <command> [options]",
    "  ficta <agent> [args...]",
    "",
    "Commands:",
    renderHelpRows([
      ["setup", "Configure registry sources in ~/.ficta/config.toml"],
      ["doctor [agent]", "Check config, registry sources, and agent routing"],
      ["install [--force] [--no-shell]", `Install ${supportedAgents.join("/")} shims into ~/.ficta/bin`],
      ["uninstall [--no-shell]", "Remove installed shims"],
      ["disable", "Globally bypass installed shims"],
      ["enable", "Re-enable installed shims globally"],
      ["version, --version, -v", "Print version information"],
      ["<agent> [args...]", "Launch an agent through an ephemeral proxy"],
    ]),
    "",
    "Agents:",
    `  ${agents}`,
    "",
    "Agent flags:",
    renderHelpRows([
      ["--allow-empty", "Bypass FICTA_REQUIRE_REGISTRY=1 for this run"],
      ["--ficta-verbose", "Print detailed registry source report at startup"],
    ]),
    "",
    "Environment:",
    renderHelpRows([
      ["FICTA_DISABLE=1", "Bypass ficta for one agent launch"],
      ["FICTA_VERBOSE=1", "Show detailed registry diagnostics at startup"],
      ["FICTA_REQUIRE_REGISTRY=1", "Refuse to launch if no protected values load"],
    ]),
    "",
    "Registry sources:",
    "  Configure with `ficta setup` or ~/.ficta/config.toml.",
  ].join("\n");
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${help}\n`);
  process.exit(exitCode);
}

function renderHelpRows(rows: Array<[string, string]>, maxWidth?: number): string {
  const width = maxWidth ?? Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, description]) => {
      if (label.length > width) return `  ${label}\n  ${"".padEnd(width)}  ${description}`;
      return `  ${label.padEnd(width)}  ${description}`;
    })
    .join("\n");
}

function renderVersion(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const packagePath = join(dirname(currentFile), "..", "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
  const version = typeof pkg.version === "string" ? pkg.version : "unknown";
  const suffix = currentFile.endsWith(join("src", "cli.ts")) ? "+dev" : "";
  return `ficta ${version}${suffix}`;
}

function extractFictaFlags(argv: string[]): { rest: string[]; allowEmpty: boolean; verbose: boolean } {
  const rest: string[] = [];
  let allowEmpty = false;
  let verbose = false;
  for (const arg of argv) {
    if (arg === "--allow-empty") allowEmpty = true;
    else if (arg === "--ficta-verbose") verbose = true;
    else rest.push(arg);
  }
  return { rest, allowEmpty, verbose };
}

function resolveAgentExecutable(command: string): string | undefined {
  const envName = `FICTA_REAL_${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const override = process.env[envName];
  if (override) return override;
  const excludeDirs = [defaultShimDir(), process.env.FICTA_SHIM_DIR].filter((v): v is string => Boolean(v));
  return findExecutable(command, { excludeDirs });
}

function runChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (e) => {
      process.stderr.write(`ficta: failed to launch: ${(e as Error).message}\n`);
      resolve(1);
    });
  });
}
