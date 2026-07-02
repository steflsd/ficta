import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, upstreamPolicyIssue } from "../src/config.js";
import { configPath, readUserConfig, writeUserConfig } from "../src/user-config.js";

const originalLogLevel = process.env.FICTA_LOG_LEVEL;
const originalConfigFile = process.env.FICTA_CONFIG_FILE;
const originalHost = process.env.FICTA_HOST;

afterEach(() => {
  if (originalLogLevel === undefined) delete process.env.FICTA_LOG_LEVEL;
  else process.env.FICTA_LOG_LEVEL = originalLogLevel;

  if (originalConfigFile === undefined) delete process.env.FICTA_CONFIG_FILE;
  else process.env.FICTA_CONFIG_FILE = originalConfigFile;

  if (originalHost === undefined) delete process.env.FICTA_HOST;
  else process.env.FICTA_HOST = originalHost;
});

describe("config hardening", () => {
  it("defaults to the info log level with raw body logging off", () => {
    delete process.env.FICTA_LOG_LEVEL;
    expect(loadConfig().logLevel).toBe("info");
    expect(loadConfig().logBodies).toBe(false);
  });

  it("binds loopback by default and honours FICTA_HOST for an explicit override", () => {
    delete process.env.FICTA_HOST;
    expect(loadConfig().host).toBe("127.0.0.1");

    // Exposing the proxy on the network is opt-in via FICTA_HOST (it forwards provider auth headers).
    process.env.FICTA_HOST = "0.0.0.0";
    expect(loadConfig().host).toBe("0.0.0.0");
  });

  it("only writes raw bodies at the trace level", () => {
    process.env.FICTA_LOG_LEVEL = "trace";
    expect(loadConfig().logBodies).toBe(true);

    for (const level of ["debug", "info", "warn", "error", "silent"]) {
      process.env.FICTA_LOG_LEVEL = level;
      expect(loadConfig().logBodies).toBe(false);
    }
  });

  it("falls back to info for an unrecognized log level", () => {
    process.env.FICTA_LOG_LEVEL = "verbose";
    expect(loadConfig().logLevel).toBe("info");
  });

  it("expands ~ in FICTA_CONFIG_FILE", () => {
    process.env.FICTA_CONFIG_FILE = "~/custom-ficta/config.toml";
    expect(configPath()).toBe(join(homedir(), "custom-ficta", "config.toml"));
  });

  it("blocks non-default upstreams unless explicitly allowed", () => {
    const cfg = { ...loadConfig(), allowCustomUpstream: false };

    expect(upstreamPolicyIssue(cfg, "https://attacker.example/v1/messages")).toContain("FICTA_ALLOW_CUSTOM_UPSTREAM=1");
    expect(upstreamPolicyIssue(cfg, "http://127.0.0.1:9000/v1/messages")).toBeUndefined();
    expect(upstreamPolicyIssue({ ...cfg, allowCustomUpstream: true }, "http://attacker.example/v1/messages")).toContain(
      "must use https",
    );
    expect(
      upstreamPolicyIssue({ ...cfg, allowCustomUpstream: true }, "https://trusted.example/v1/messages"),
    ).toBeUndefined();
  });

  it("treats only real 127.0.0.0/8 literals as loopback, not lookalike DNS names", () => {
    const cfg = { ...loadConfig(), allowCustomUpstream: false };

    // Genuine loopback literals bypass the custom-upstream gate.
    expect(upstreamPolicyIssue(cfg, "http://127.0.0.1:9000/v1/messages")).toBeUndefined();
    expect(upstreamPolicyIssue(cfg, "http://127.1.2.3:9000/v1/messages")).toBeUndefined();
    // Shorthand IPv4 loopback forms are normalized to dotted-quad by URL parsing, so they too pass.
    expect(upstreamPolicyIssue(cfg, "http://127.1:9000/v1/messages")).toBeUndefined();
    expect(upstreamPolicyIssue(cfg, "http://2130706433:9000/v1/messages")).toBeUndefined();

    // Registrable names that merely start with "127." resolve to public IPs and must be gated.
    expect(upstreamPolicyIssue(cfg, "http://127.0.0.1.attacker.example/v1/messages")).toContain(
      "FICTA_ALLOW_CUSTOM_UPSTREAM=1",
    );
    expect(upstreamPolicyIssue(cfg, "http://127.foo.com/v1/messages")).toContain("FICTA_ALLOW_CUSTOM_UPSTREAM=1");
    // …and even when custom upstreams are allowed, they still must use https.
    expect(
      upstreamPolicyIssue({ ...cfg, allowCustomUpstream: true }, "http://127.0.0.1.attacker.example/v1/messages"),
    ).toContain("must use https");
  });

  it("persists user config as TOML and reads it as effective settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-config-"));
    const path = join(dir, "config.toml");
    try {
      writeUserConfig(
        {
          FICTA_REGISTRY_ENV_FILE_ENABLED: "1",
          FICTA_REGISTRY_ENV_FILE_PATHS: ".env:.env.local:.env.production",
          FICTA_REGISTRY_DOPPLER_ENABLED: "1",
          FICTA_REGISTRY_DOPPLER_CONFIGS: "dev,prod",
          FICTA_REGISTRY_MIN_LEN: "12",
          FICTA_REQUIRE_REGISTRY: "1",
          FICTA_LOG_MAX_BYTES: "12345",
          FICTA_ALLOW_CUSTOM_UPSTREAM: "1",
        },
        path,
      );

      expect(readFileSync(path, "utf8")).toContain("[registry.env_file]");
      expect(readFileSync(path, "utf8")).toContain('paths = [".env", ".env.local", ".env.production"]');
      expect(readUserConfig(path)).toMatchObject({
        FICTA_REGISTRY_ENV_FILE_ENABLED: "1",
        FICTA_REGISTRY_ENV_FILE_PATHS: ".env:.env.local:.env.production",
        FICTA_REGISTRY_DOPPLER_ENABLED: "1",
        FICTA_REGISTRY_DOPPLER_CONFIGS: "dev,prod",
        FICTA_REGISTRY_MIN_LEN: "12",
        FICTA_REQUIRE_REGISTRY: "1",
        FICTA_LOG_MAX_BYTES: "12345",
        FICTA_ALLOW_CUSTOM_UPSTREAM: "1",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips the per-surface PII toggles as [pii] booleans", () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-config-"));
    const path = join(dir, "config.toml");
    try {
      writeUserConfig({ FICTA_PII_ENABLED: "1", FICTA_PII_AGENTS: "1" }, path);

      const toml = readFileSync(path, "utf8");
      expect(toml).toContain("[pii]");
      expect(toml).toContain("enabled = true");
      expect(toml).toContain("agents = true");
      expect(readUserConfig(path)).toMatchObject({ FICTA_PII_ENABLED: "1", FICTA_PII_AGENTS: "1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips registry.exclude_names as a comma list, and a single name as a string", () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-config-"));
    const path = join(dir, "config.toml");
    try {
      writeUserConfig({ FICTA_REGISTRY_EXCLUDE_NAMES: "FOO,BAR_1" }, path);
      expect(readFileSync(path, "utf8")).toContain('exclude_names = ["FOO", "BAR_1"]');
      expect(readUserConfig(path)).toMatchObject({ FICTA_REGISTRY_EXCLUDE_NAMES: "FOO,BAR_1" });

      // A single name serializes as a TOML string but parses back to the same env value.
      writeUserConfig({ FICTA_REGISTRY_EXCLUDE_NAMES: "SOLO" }, path);
      expect(readUserConfig(path)).toMatchObject({ FICTA_REGISTRY_EXCLUDE_NAMES: "SOLO" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
