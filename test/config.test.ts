import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { configPath, readUserConfig, writeUserConfig } from "../src/user-config.js";

const originalLogBodies = process.env.FICTA_LOG_BODIES;
const originalConfigFile = process.env.FICTA_CONFIG_FILE;

afterEach(() => {
  if (originalLogBodies === undefined) delete process.env.FICTA_LOG_BODIES;
  else process.env.FICTA_LOG_BODIES = originalLogBodies;

  if (originalConfigFile === undefined) delete process.env.FICTA_CONFIG_FILE;
  else process.env.FICTA_CONFIG_FILE = originalConfigFile;
});

describe("config hardening", () => {
  it("keeps raw body logging off by default", () => {
    delete process.env.FICTA_LOG_BODIES;
    expect(loadConfig().logBodies).toBe(false);
  });

  it("requires explicit opt-in for raw body logging", () => {
    process.env.FICTA_LOG_BODIES = "1";
    expect(loadConfig().logBodies).toBe(true);

    process.env.FICTA_LOG_BODIES = "0";
    expect(loadConfig().logBodies).toBe(false);
  });

  it("expands ~ in FICTA_CONFIG_FILE", () => {
    process.env.FICTA_CONFIG_FILE = "~/custom-ficta/config.toml";
    expect(configPath()).toBe(join(homedir(), "custom-ficta", "config.toml"));
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
          FICTA_LOG_BODIES: "0",
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
        FICTA_LOG_BODIES: "0",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
