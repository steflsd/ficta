import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDoctorReport, doctorExitCode, renderDoctorReport } from "../src/doctor.js";
import { resetPluginCachesForTests } from "../src/plugins/index.js";

const ENV_KEYS = [
  "PATH",
  "FICTA_REGISTRY_ENV_FILE_ENABLED",
  "FICTA_REGISTRY_ENV_FILE_PATHS",
  "FICTA_REGISTRY_PROCESS_ENV_ENABLED",
  "FICTA_REGISTRY_PROCESS_ENV_MODE",
  "FICTA_REGISTRY_DOPPLER_ENABLED",
  "FICTA_REGISTRY_MIN_LEN",
  "FICTA_REGISTRY_EXCLUDE_NAMES",
  "DOPPLER_CONFIG",
  "FICTA_REQUIRE_REGISTRY",
  "FICTA_FAIL_CLOSED",
  "FICTA_LOG_LEVEL",
  "FICTA_SURROGATE_KEY",
  "FICTA_SHIM_DIR",
  "FICTA_REAL_CLAUDE",
  "FICTA_REAL_CODEX",
  "CODEX_HOME",
  "FICTA_PII_ENABLED",
  "FICTA_PII_AGENTS",
  "FICTA_PII_BACKEND",
  "FICTA_PII_FAIL_CLOSED",
  "FICTA_FAIL_CLOSED_DETECTION",
  "FICTA_PII_PRESIDIO_URL",
  "FICTA_PII_PRESIDIO_TIMEOUT_MS",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  resetPluginCachesForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPluginCachesForTests();
});

describe("ficta doctor", () => {
  it("reports loaded registry values and selected agent routing", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
    process.env.FICTA_REGISTRY_MIN_LEN = "6";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_REQUIRE_REGISTRY = "1";
    process.env.FICTA_SURROGATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const report = await collectDoctorReport({ agent: "claude" });
    const rendered = renderDoctorReport(report);

    expect(report.registry.protectedValues).toBeGreaterThan(0);
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]?.status).toBe("ok");
    expect(report.agents[0]?.route).toContain("ANTHROPIC_BASE_URL");
    expect(doctorExitCode(report)).toBe(0);
    expect(rendered).toContain("registry");
    expect(rendered).toContain("protected values loaded");
  });

  it("warns and reports the level when FICTA_LOG_LEVEL=trace would write raw bodies", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_LOG_LEVEL = "trace";

    const report = await collectDoctorReport({ agent: "claude" });
    const rendered = renderDoctorReport(report);

    expect(report.config.logLevel).toBe("trace");
    expect(report.config.logBodies).toBe(true);
    expect(report.issues).toContainEqual({
      severity: "warning",
      message: "FICTA_LOG_LEVEL=trace is set; raw model bodies may be written to disk",
    });
    expect(rendered).toContain("log level: trace");
    expect(rendered).toContain("raw body logs: ON");
  });

  it("reports PII posture per surface: standalone on, agent launches off unless pii.agents", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_SURROGATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    // [pii] enabled on, [pii] agents unset → standalone/web on, coding agents still off.
    process.env.FICTA_PII_ENABLED = "1";
    delete process.env.FICTA_PII_AGENTS;
    let report = await collectDoctorReport({ agent: "claude" });
    expect(report.config.piiStandalone).toBe(true);
    expect(report.config.piiAgents).toBe(false);
    expect(renderDoctorReport(report)).toContain("standalone/web on; agent launches off (pii.agents)");

    // Opt agents in → both on.
    process.env.FICTA_PII_AGENTS = "1";
    report = await collectDoctorReport({ agent: "claude" });
    expect(report.config.piiAgents).toBe(true);
    expect(renderDoctorReport(report)).toContain("standalone/web on; agent launches on (pii.agents)");
  });

  it("returns an error when strict mode has no loaded registry", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/missing.env";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_REQUIRE_REGISTRY = "1";
    process.env.FICTA_SURROGATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const report = await collectDoctorReport({ agent: "claude" });

    expect(report.registry.protectedValues).toBe(0);
    expect(doctorExitCode(report)).toBe(1);
    expect(report.issues).toContainEqual({
      severity: "error",
      message: "no protected values loaded, and FICTA_REQUIRE_REGISTRY=1 would block agent launch",
    });
  });

  it("annotates the excluding source and lists policy rules without a duplicate count line", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "1";
    process.env.FICTA_REGISTRY_PROCESS_ENV_MODE = "all";
    process.env.FICTA_REGISTRY_MIN_LEN = "3";
    process.env.DOPPLER_CONFIG = "local-routing-config";
    process.env.FICTA_SURROGATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const rendered = renderDoctorReport(await collectDoctorReport({ agent: "claude" }));

    expect(rendered).toContain("registry policy exclusions:");
    expect(rendered).toMatch(/process env.*\(\d+ excluded by policy\)/);
    expect(rendered).not.toContain("registry policy excluded:");
  });

  it("renders the user exclusion rule and warns on invalid exclude_names entries", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_REGISTRY_MIN_LEN = "6";
    process.env.FICTA_REGISTRY_EXCLUDE_NAMES = "AWS_KEY, not a name";
    process.env.FICTA_SURROGATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const report = await collectDoctorReport({ agent: "claude" });
    const rendered = renderDoctorReport(report);

    // Valid name is enforced and shown; invalid entry is reported as a warning.
    expect(rendered).toContain("AWS_KEY");
    expect(report.issues).toContainEqual({
      severity: "warning",
      message: "registry.exclude_names has invalid entries (ignored): not a name",
    });
  });

  it("shows Codex ChatGPT/OAuth routing when auth.json indicates chatgpt mode", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "codex"));
    const codexHome = tempDir("ficta-codex-home-");
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }), { mode: 0o600 });
    process.env.PATH = [bin, process.env.PATH ?? ""].join(delimiter);
    process.env.CODEX_HOME = codexHome;
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_SURROGATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const report = await collectDoctorReport({ agent: "codex" });

    expect(report.agents[0]?.status).toBe("ok");
    expect(report.agents[0]?.route).toContain("ChatGPT/OAuth detected");
  });

  it("warns when the presidio backend is selected but unreachable", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${await closedPort()}`;
    process.env.FICTA_PII_PRESIDIO_TIMEOUT_MS = "300";

    const report = await collectDoctorReport({ agent: "claude" });

    expect(report.issues.some((i) => i.severity === "warning" && i.message.includes('PII backend "presidio"'))).toBe(
      true,
    );
  });

  it("warns that requests will be blocked when presidio is down and fail_closed is set", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "presidio";
    process.env.FICTA_PII_FAIL_CLOSED = "1";
    process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${await closedPort()}`;
    process.env.FICTA_PII_PRESIDIO_TIMEOUT_MS = "300";

    const report = await collectDoctorReport({ agent: "claude" });

    expect(report.issues.some((i) => i.severity === "warning" && i.message.includes("BLOCKED"))).toBe(true);
  });

  it("does not probe presidio when the regex backend is selected", async () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_PII_ENABLED = "1";
    process.env.FICTA_PII_BACKEND = "regex";

    const report = await collectDoctorReport({ agent: "claude" });

    expect(report.issues.some((i) => i.message.includes("presidio"))).toBe(false);
  });
});

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), name));
}

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

/** Bind then release a loopback port so a subsequent connection to it is refused. */
async function closedPort(): Promise<number> {
  const server: Server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
