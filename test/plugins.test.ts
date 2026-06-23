import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadPluginRegistry,
  registrySetupDefaults,
  registrySetupSources,
  resetPluginCachesForTests,
  validatePluginBoundaries,
} from "../src/plugins/index.js";

const ENV_KEYS = [
  "FICTA_CONFIG_FILE",
  "FICTA_REGISTRY_ENV_FILE_ENABLED",
  "FICTA_REGISTRY_ENV_FILE_PATHS",
  "FICTA_REGISTRY_MIN_LEN",
  "FICTA_REGISTRY_PROCESS_ENV_ENABLED",
  "FICTA_REGISTRY_PROCESS_ENV_MODE",
  "FICTA_REGISTRY_DOPPLER_ENABLED",
  "FICTA_REGISTRY_DOPPLER_COMMAND",
  "FICTA_REGISTRY_DOPPLER_CONFIGS",
  "FICTA_REGISTRY_DOPPLER_PROJECT",
  "FICTA_REGISTRY_DOPPLER_TIMEOUT_MS",
  "TEST_DOPPLER_API_KEY",
  "ANTHROPIC_API_KEY",
  "PATH",
] as const;

let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.FICTA_CONFIG_FILE = "0";
  process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
  process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
  process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
  resetPluginCachesForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPluginCachesForTests();
});

describe("registry plugin discovery", () => {
  it("discovers and loads env-file sources at launch", () => {
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
    process.env.FICTA_REGISTRY_MIN_LEN = "6";

    const snapshot = loadPluginRegistry();
    const envFile = snapshot.discoveries.find((d) => d.id === "known-env-values/env-file");

    expect(snapshot.values.length).toBeGreaterThanOrEqual(4);
    expect(envFile?.status).toBe("loaded");
    expect(envFile?.valueCount).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(snapshot.discoveries)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("can disable env-file sources independently", () => {
    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
    process.env.FICTA_REGISTRY_MIN_LEN = "6";

    const snapshot = loadPluginRegistry();

    expect(snapshot.values.some((v) => v.name === "AWS_KEY")).toBe(false);
    expect(snapshot.discoveries.find((d) => d.id === "known-env-values/env-file")?.status).toBe("disabled");
  });

  it("keeps known-env setup/default metadata owned by the known-env registry plugin", () => {
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";

    const envFileSource = registrySetupSources().find((source) => source.id === "known-env-values/env-file");

    expect(envFileSource?.defaultEnabled).toBe(true);
    expect(envFileSource?.label).toContain("found test/fixtures/secrets.env");
    expect(registrySetupDefaults()).toMatchObject({
      FICTA_REGISTRY_PROCESS_ENV_ENABLED: "1",
      FICTA_REGISTRY_PROCESS_ENV_MODE: "secret-ish",
    });

    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    expect(registrySetupSources().find((source) => source.id === "known-env-values/env-file")?.defaultEnabled).toBe(
      false,
    );
  });

  it("rejects registry-source hooks that bypass the plugin boundary contract", () => {
    expect(() => validatePluginBoundaries([{ name: "bad-registry", loadValues: () => [] } as any])).toThrow(
      /kind="registry-source"/,
    );

    expect(() =>
      validatePluginBoundaries([
        {
          kind: "registry-source",
          name: "bad-registry",
          config: { bindings: [], sections: [], envDefaults: {} },
          discover: () => [],
          loadValues: () => [],
          setup: {},
        } as any,
      ]),
    ).toThrow(/setup\.registrySources/);
  });

  it("keeps Doppler setup defaults owned by the Doppler registry plugin", () => {
    delete process.env.FICTA_REGISTRY_DOPPLER_ENABLED;
    process.env.PATH = "";
    expect(registrySetupSources().find((source) => source.id === "doppler-cli/secrets-download")?.defaultEnabled).toBe(
      false,
    );

    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "1";
    expect(registrySetupSources().find((source) => source.id === "doppler-cli/secrets-download")?.defaultEnabled).toBe(
      true,
    );

    delete process.env.FICTA_REGISTRY_DOPPLER_ENABLED;
    const bin = mkdtempSync(join(tmpdir(), "ficta-doppler-path-test-"));
    const command = join(bin, "doppler");
    writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(command, 0o700);
    process.env.PATH = bin;

    expect(registrySetupSources().find((source) => source.id === "doppler-cli/secrets-download")?.defaultEnabled).toBe(
      true,
    );
  });

  it("reports env-file read errors without dropping other registry sources", () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-env-dir-"));
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = dir;
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "1";
    process.env.FICTA_REGISTRY_PROCESS_ENV_MODE = "secret-ish";
    process.env.TEST_DOPPLER_API_KEY = "process-env-fixture-secret-value";

    const snapshot = loadPluginRegistry();
    const envFile = snapshot.discoveries.find((d) => d.id === "known-env-values/env-file");

    expect(snapshot.values.some((v) => v.name === "TEST_DOPPLER_API_KEY")).toBe(true);
    expect(envFile?.status).toBe("error");
    expect(envFile?.message).toContain("could not read");
  });

  it("parses common dotenv double-quoted escapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ficta-env-file-"));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, 'PRIVATE_KEY="line1\\nline2"\n', { mode: 0o600 });
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = envFile;
    process.env.FICTA_REGISTRY_MIN_LEN = "4";

    const snapshot = loadPluginRegistry();

    expect(snapshot.values.find((v) => v.name === "PRIVATE_KEY")?.value).toBe("line1\nline2");
  });

  it("refuses Doppler commands resolved inside the current working tree", () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "ficta-doppler-cwd-"));
    const command = join(dir, "doppler");
    writeFileSync(command, "#!/bin/sh\nprintf '%s\\n' '{\"DOPPLER_SECRET\":\"should-not-load\"}'\n", { mode: 0o700 });
    chmodSync(command, 0o700);

    try {
      process.chdir(dir);
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
      process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "1";
      process.env.FICTA_REGISTRY_DOPPLER_COMMAND = command;

      const snapshot = loadPluginRegistry();
      const doppler = snapshot.discoveries.find((d) => d.id === "doppler-cli/secrets-download");

      expect(snapshot.values.some((v) => v.value === "should-not-load")).toBe(false);
      expect(doppler?.status).toBe("error");
      expect(doppler?.message).toContain("untrusted Doppler command");
    } finally {
      process.chdir(cwd);
    }
  });

  it("runs Doppler with a minimal child environment", () => {
    const secret = "doppler-provider-fixture-secret-value";
    const bin = mkdtempSync(join(tmpdir(), "ficta-doppler-env-test-"));
    const command = join(bin, "doppler");
    writeFileSync(
      command,
      `#!/bin/sh
if [ -n "$ANTHROPIC_API_KEY" ]; then
  printf '%s\n' '{"LEAK":"provider-key-was-forwarded"}'
else
  printf '%s\n' '{"DOPPLER_SECRET":"${secret}"}'
fi
`,
      { mode: 0o700 },
    );
    chmodSync(command, 0o700);

    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "1";
    process.env.FICTA_REGISTRY_DOPPLER_COMMAND = command;
    process.env.ANTHROPIC_API_KEY = "provider-key-should-not-reach-doppler";

    const snapshot = loadPluginRegistry();

    expect(snapshot.values.some((v) => v.name === "DOPPLER_SECRET" && v.value === secret)).toBe(true);
    expect(snapshot.values.some((v) => v.name === "LEAK")).toBe(false);
  });

  it("loads Doppler CLI secrets at startup before the agent launches", () => {
    const secret = "doppler-provider-fixture-secret-value";
    const bin = mkdtempSync(join(tmpdir(), "ficta-doppler-test-"));
    const command = join(bin, "doppler");
    writeFileSync(
      command,
      `#!/bin/sh
if [ "$1" != "secrets" ] || [ "$2" != "download" ]; then exit 64; fi
printf '%s\n' '{"DOPPLER_SECRET":"${secret}","SHORT":"tiny"}'
`,
      { mode: 0o700 },
    );
    chmodSync(command, 0o700);

    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "1";
    process.env.FICTA_REGISTRY_DOPPLER_COMMAND = command;
    process.env.FICTA_REGISTRY_MIN_LEN = "8";

    const snapshot = loadPluginRegistry();
    const doppler = snapshot.discoveries.find((d) => d.id === "doppler-cli/secrets-download");

    expect(snapshot.values.some((v) => v.name === "DOPPLER_SECRET" && v.value === secret)).toBe(true);
    expect(snapshot.values.some((v) => v.name === "SHORT")).toBe(false);
    expect(doppler?.status).toBe("loaded");
    expect(doppler?.valueCount).toBe(1);
    expect(JSON.stringify(snapshot.discoveries)).not.toContain(secret);
  });

  it("can load every config in the active Doppler project", () => {
    const devSecret = "doppler-dev-fixture-secret-value";
    const prodSecret = "doppler-prod-fixture-secret-value";
    const bin = mkdtempSync(join(tmpdir(), "ficta-doppler-test-"));
    const command = join(bin, "doppler");
    writeFileSync(
      command,
      `#!/bin/sh
if [ "$1" = "configs" ]; then
  printf '%s\n' '[{"name":"dev"},{"name":"prod"}]'
  exit 0
fi
if [ "$1" = "secrets" ] && [ "$2" = "download" ]; then
  config=current
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--config" ]; then shift; config="$1"; fi
    shift
  done
  case "$config" in
    dev) printf '%s\n' '{"DEV_SECRET":"${devSecret}"}' ;;
    prod) printf '%s\n' '{"PROD_SECRET":"${prodSecret}"}' ;;
    *) printf '%s\n' '{}' ;;
  esac
  exit 0
fi
exit 64
`,
      { mode: 0o700 },
    );
    chmodSync(command, 0o700);

    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "1";
    process.env.FICTA_REGISTRY_DOPPLER_COMMAND = command;
    process.env.FICTA_REGISTRY_DOPPLER_CONFIGS = "all";
    process.env.FICTA_REGISTRY_DOPPLER_PROJECT = "fixture-project";
    process.env.FICTA_REGISTRY_MIN_LEN = "8";

    const snapshot = loadPluginRegistry();
    const doppler = snapshot.discoveries.find((d) => d.id === "doppler-cli/secrets-download");

    expect(snapshot.values.some((v) => v.name === "DEV_SECRET" && v.value === devSecret)).toBe(true);
    expect(snapshot.values.some((v) => v.name === "PROD_SECRET" && v.value === prodSecret)).toBe(true);
    expect(doppler?.status).toBe("loaded");
    expect(doppler?.valueCount).toBe(2);
    expect(doppler?.message).toContain("2/2 config");
    expect(doppler?.details).toEqual(["fixture-project/dev: 1 loaded", "fixture-project/prod: 1 loaded"]);
    expect(JSON.stringify(snapshot.discoveries)).not.toContain(devSecret);
    expect(JSON.stringify(snapshot.discoveries)).not.toContain(prodSecret);
  });

  it("loads secret-ish process env only when that source is enabled", () => {
    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "1";
    process.env.FICTA_REGISTRY_PROCESS_ENV_MODE = "secret-ish";
    process.env.TEST_DOPPLER_API_KEY = "doppler-fixture-secret-value";

    const snapshot = loadPluginRegistry();
    const processEnv = snapshot.discoveries.find((d) => d.id === "known-env-values/process-env");

    expect(snapshot.values.some((v) => v.name === "TEST_DOPPLER_API_KEY")).toBe(true);
    expect(processEnv?.status).toBe("loaded");
    expect(processEnv?.message).toContain("secret-ish env names");
  });
});
