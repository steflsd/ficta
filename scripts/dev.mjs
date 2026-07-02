#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ENV_FILES = [
  ".env",
  ".env.local",
  "packages/ficta/.env",
  "packages/ficta/.env.local",
  "apps/web/.env",
  "apps/web/.env.local",
];

const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

const { forceDoppler, forwardArgs } = parseArgs(process.argv.slice(2));
const env = { ...process.env, DOPPLER_NO_UPDATE_CHECK: "1" };
const doppler = decideDoppler(env, forceDoppler);
const localEnv = loadLocalEnvFiles(env);

if (!doppler.use && env.FICTA_REGISTRY_DOPPLER_ENABLED === undefined) {
  // In the local .env path, don't let the proxy's registry source try Doppler just because the CLI
  // is installed. Users can still force it with FICTA_REGISTRY_DOPPLER_ENABLED=1 or `pnpm dev -- --doppler`.
  env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
}

const envSummary = localEnv.files.length > 0 ? `loaded ${localEnv.files.join(", ")}` : "no .env files found";
if (doppler.use) {
  console.log(`[dev] using Doppler (${doppler.reason}); ${envSummary} as fallback`);
  run("doppler", ["--no-check-version", "run", "--forward-signals", "--", "pnpm", "dev:all", ...forwardArgs], env);
} else {
  console.log(`[dev] using local env (${doppler.reason}); ${envSummary}`);
  run("pnpm", ["dev:all", ...forwardArgs], env);
}

function parseArgs(args) {
  let forceDoppler = "auto";
  const forwardArgs = [];

  for (const arg of args) {
    if (arg === "--") continue;
    if (arg === "--doppler") {
      forceDoppler = "on";
      continue;
    }
    if (arg === "--no-doppler" || arg === "--env") {
      forceDoppler = "off";
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    forwardArgs.push(arg);
  }

  return { forceDoppler, forwardArgs };
}

function printHelp() {
  console.log(
    `Usage: pnpm dev [-- --doppler | --no-doppler]\n\nStarts the proxy and web app. By default this wrapper uses Doppler when the\ncheckout has Doppler project/config metadata, otherwise it loads local .env\nfiles and starts the same dev tasks without Doppler.\n\nOptions:\n  --doppler      Force \`doppler run -- pnpm dev:all\`\n  --no-doppler   Force local .env mode\n`,
  );
}

function decideDoppler(env, forceDoppler) {
  if (forceDoppler === "on") return { use: true, reason: "forced by --doppler" };
  if (forceDoppler === "off") return { use: false, reason: "forced by --no-doppler" };

  const envPreference = parseDopplerPreference(env.FICTA_DEV_DOPPLER ?? env.FICTA_DEV_USE_DOPPLER);
  if (envPreference === true) return { use: true, reason: "forced by FICTA_DEV_DOPPLER" };
  if (envPreference === false) return { use: false, reason: "disabled by FICTA_DEV_DOPPLER" };

  if (env.DOPPLER_TOKEN) return { use: true, reason: "DOPPLER_TOKEN is set" };

  const config = detectDopplerConfig(env);
  if (config.ok) return { use: true, reason: config.reason };
  return { use: false, reason: config.reason };
}

function parseDopplerPreference(value) {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "doppler"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "env", "local", "dotenv"].includes(normalized)) return false;
  return undefined;
}

function detectDopplerConfig(env) {
  const result = spawnSync(
    "doppler",
    ["configure", "get", "project", "config", "--json", "--silent", "--scope", rootDir, "--no-check-version"],
    {
      cwd: rootDir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
      windowsHide: true,
    },
  );

  if (result.error) {
    return result.error.message.includes("ENOENT")
      ? { ok: false, reason: "Doppler CLI not found" }
      : { ok: false, reason: "Doppler config check failed" };
  }
  if (result.status !== 0) return { ok: false, reason: "no Doppler project/config detected" };

  try {
    const values = JSON.parse(result.stdout || "{}");
    const project = values["enclave.project"] ?? values.project ?? values.DOPPLER_PROJECT;
    const config = values["enclave.config"] ?? values.config ?? values.DOPPLER_CONFIG;
    if (project && config) return { ok: true, reason: `detected ${project}/${config}` };
  } catch {
    return { ok: false, reason: "Doppler config check returned invalid JSON" };
  }

  return { ok: false, reason: "no Doppler project/config detected" };
}

function loadLocalEnvFiles(env) {
  const merged = new Map();
  const files = [];

  for (const relativePath of ENV_FILES) {
    const path = resolve(rootDir, relativePath);
    if (!existsSync(path)) continue;
    files.push(relative(rootDir, path));
    const values = parseEnvFile(readFileSync(path, "utf8"));
    for (const [key, value] of values) merged.set(key, value);
  }

  let applied = 0;
  for (const [key, value] of merged) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    applied++;
  }

  return { files, applied };
}

function parseEnvFile(text) {
  const values = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const name = match[1];
    const rawValue = match[2] ?? "";
    const trimmed = rawValue.trimStart();
    const quote = trimmed[0];
    let value;

    if (quote === '"' || quote === "'") {
      let quoted = trimmed;
      let close = closingQuoteIndex(quoted, quote);
      while (close === -1 && i + 1 < lines.length) {
        i++;
        quoted += `\n${lines[i] ?? ""}`;
        close = closingQuoteIndex(quoted, quote);
      }
      value = close === -1 ? quoted.slice(1) : quoted.slice(1, close);
      if (quote === '"') value = unescapeDoubleQuotedEnv(value);
    } else {
      value = stripComment(rawValue).trim();
    }

    values.push([name, value]);
  }

  return values;
}

function closingQuoteIndex(value, quote) {
  for (let i = 1; i < value.length; i++) {
    if (value[i] !== quote) continue;
    if (quote === "'" || !isEscaped(value, i)) return i;
  }
  return -1;
}

function isEscaped(value, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function unescapeDoubleQuotedEnv(value) {
  return value.replace(/\\([nrt"\\$])/g, (_match, escaped) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return escaped;
    }
  });
}

function stripComment(value) {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "#" && (i === 0 || /\s/.test(value[i - 1] ?? ""))) return value.slice(0, i);
  }
  return value;
}

function run(command, args, env) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };

  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) process.on(signal, forwardSignal);

  child.on("error", (error) => {
    for (const signal of Object.keys(SIGNAL_EXIT_CODES)) process.off(signal, forwardSignal);
    console.error(`[dev] failed to start ${command}: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    for (const signalName of Object.keys(SIGNAL_EXIT_CODES)) process.off(signalName, forwardSignal);
    if (signal) process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
    process.exit(code ?? 0);
  });
}
