// ficta <agent> [args...]
// Starts an ephemeral redaction proxy and launches the agent pointed at it.
// `ficta install` adds shell shims so users can keep typing `claude` / `codex` / `pi`.
import { type ChildProcess, spawn } from "node:child_process";
import { sanitizeAgentEnv } from "./child-env.js";
import { applyRuntimeEnvDefaults } from "./defaults.js";
import { defaultShimDir, findExecutable, installShims, uninstallShims } from "./install.js";
import { agentCommands, findAgentIntegration, registryDiscoveryLines } from "./plugins/index.js";
import { ensureSurrogateKey, loadUserConfig } from "./user-config.js";

loadUserConfig();

const args = process.argv.slice(2);
const command = args[0];
const supportedAgents = agentCommands();

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
    `\nRestart your shell, then run:\n  ${supportedAgents.join("\n  ")}\n\nBypass once with: FICTA_DISABLE=1 ${supportedAgents[0] ?? "claude"}\n`,
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

if (command === "doctor") {
  const { collectDoctorReport, doctorExitCode, renderDoctorReport } = await import("./doctor.js");
  const report = collectDoctorReport({ agent: args[1] });
  process.stderr.write(renderDoctorReport(report));
  process.exit(doctorExitCode(report));
}

const agent = findAgentIntegration(command);
if (!agent) printHelp(2);
const { rest, allowEmpty } = extractFictaFlags(args.slice(1));

// Escape hatch for installed shims: run the real agent without starting ficta.
if (process.env.FICTA_DISABLE === "1") {
  const agentPath = resolveAgentExecutable(agent.command);
  if (!agentPath) {
    process.stderr.write(`ficta: FICTA_DISABLE=1 but could not find real ${agent.command} outside the shim dir\n`);
    process.exit(127);
  }
  const env = sanitizeAgentEnv(process.env);
  const plan = agent.configureBypass?.({ args: rest, realExecutable: agentPath, env, cwd: process.cwd() }) ?? {
    executable: agentPath,
    args: rest,
    env,
  };
  process.stderr.write(`ficta disabled — launching ${plan.executable}\n`);
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
  `🔒 ficta — ${proxy.protectedValues} protected value(s) loaded; routing ${agent.command} → ${base}\n`,
);
process.stderr.write("   registry sources:\n");
for (const line of registryDiscoveryLines(proxy.registry, "     ")) process.stderr.write(`${line}\n`);

if (
  proxy.protectedValues === 0 &&
  process.env.FICTA_REQUIRE_REGISTRY === "1" &&
  !allowEmpty &&
  process.env.FICTA_ALLOW_EMPTY !== "1"
) {
  process.stderr.write(
    "\n🛑 ficta found no protected values and FICTA_REQUIRE_REGISTRY=1 is set.\n" +
      "   Add a .env/.env.local, configure Doppler, run `ficta setup`,\n" +
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
  const agents = supportedAgents.length > 0 ? supportedAgents.join("|") : "agent";
  process.stderr.write(
    "ficta — keep your registered secrets out of the LLM\n\n" +
      "usage:\n" +
      "  ficta setup                   configure registry sources in ~/.ficta/config.env\n" +
      "  ficta doctor [agent]          check config, registry sources, and agent routing\n" +
      `  ficta install                 install ${supportedAgents.join("/")} shims into ~/.ficta/bin\n` +
      "  ficta uninstall               remove installed shims\n" +
      `  ficta <${agents}> [args]       launch an agent through an ephemeral proxy\n\n` +
      "agent flags:\n" +
      "  --allow-empty                 bypass FICTA_REQUIRE_REGISTRY=1 for this run\n\n" +
      "env:\n" +
      `  FICTA_DISABLE=1 ${supportedAgents[0] ?? "claude"}        bypass an installed shim once\n` +
      "  FICTA_REQUIRE_REGISTRY=1      block agent launch when no protected values load\n" +
      "  FICTA_REGISTRY_PROCESS_ENV_ENABLED=0  disable secret-ish process-env loading\n" +
      "  FICTA_REGISTRY_DOPPLER_ENABLED=0      skip Doppler CLI startup loading\n" +
      "  FICTA_REGISTRY_DOPPLER_CONFIGS=dev,prod|all  load additional Doppler configs\n",
  );
  process.exit(exitCode);
}

function extractFictaFlags(argv: string[]): { rest: string[]; allowEmpty: boolean } {
  const rest: string[] = [];
  let allowEmpty = false;
  for (const arg of argv) {
    if (arg === "--allow-empty") allowEmpty = true;
    else rest.push(arg);
  }
  return { rest, allowEmpty };
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
