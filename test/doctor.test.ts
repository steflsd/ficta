import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
  "DOPPLER_CONFIG",
  "FICTA_REQUIRE_REGISTRY",
  "FICTA_FAIL_CLOSED",
  "FICTA_LOG_BODIES",
  "FICTA_SURROGATE_KEY",
  "FICTA_SHIM_DIR",
  "FICTA_REAL_CLAUDE",
  "FICTA_REAL_CODEX",
  "CODEX_HOME",
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
  it("reports loaded registry values and selected agent routing", () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
    process.env.FICTA_REGISTRY_MIN_LEN = "6";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_REQUIRE_REGISTRY = "1";
    process.env.FICTA_SURROGATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const report = collectDoctorReport({ agent: "claude" });
    const rendered = renderDoctorReport(report);

    expect(report.registry.protectedValues).toBeGreaterThan(0);
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]?.status).toBe("ok");
    expect(report.agents[0]?.route).toContain("ANTHROPIC_BASE_URL");
    expect(doctorExitCode(report)).toBe(0);
    expect(rendered).toContain("registry");
    expect(rendered).toContain("protected values loaded");
  });

  it("returns an error when strict mode has no loaded registry", () => {
    const bin = tempDir("ficta-doctor-bin-");
    executable(join(bin, "claude"));
    process.env.PATH = bin;
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/missing.env";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
    process.env.FICTA_REQUIRE_REGISTRY = "1";
    process.env.FICTA_SURROGATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const report = collectDoctorReport({ agent: "claude" });

    expect(report.registry.protectedValues).toBe(0);
    expect(doctorExitCode(report)).toBe(1);
    expect(report.issues).toContainEqual({
      severity: "error",
      message: "no protected values loaded, and FICTA_REQUIRE_REGISTRY=1 would block agent launch",
    });
  });

  it("annotates the excluding source and lists policy rules without a duplicate count line", () => {
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

    const rendered = renderDoctorReport(collectDoctorReport({ agent: "claude" }));

    expect(rendered).toContain("registry policy exclusions:");
    expect(rendered).toMatch(/process env.*\(\d+ excluded by policy\)/);
    expect(rendered).not.toContain("registry policy excluded:");
  });

  it("shows Codex ChatGPT/OAuth routing when auth.json indicates chatgpt mode", () => {
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

    const report = collectDoctorReport({ agent: "codex" });

    expect(report.agents[0]?.status).toBe("ok");
    expect(report.agents[0]?.route).toContain("ChatGPT/OAuth detected");
  });
});

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), name));
}

function executable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}
