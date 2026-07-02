import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRegistryPolicy,
  type FictaPlugin,
  loadPluginRegistry,
  parseUserExclusionRule,
  pluginConfigBindings,
  pluginConfigSections,
  pluginEnvDefaults,
  protectedValueExcludedBy,
  registryDiscoveryLines,
  registrySetupDefaults,
  registrySetupSources,
  resetPluginCachesForTests,
  USER_EXCLUSION_PLUGIN,
  USER_EXCLUSION_RULE_ID,
  validatePluginBoundaries,
} from "../src/plugins/index.js";

const ENV_KEYS = [
  "FICTA_CONFIG_FILE",
  "FICTA_REGISTRY_ENV_FILE_ENABLED",
  "FICTA_REGISTRY_ENV_FILE_PATHS",
  "FICTA_REGISTRY_MIN_LEN",
  "FICTA_REGISTRY_EXCLUDE_NAMES",
  "FICTA_REGISTRY_PROCESS_ENV_ENABLED",
  "FICTA_REGISTRY_PROCESS_ENV_MODE",
  "FICTA_REGISTRY_DOPPLER_ENABLED",
  "FICTA_REGISTRY_DOPPLER_COMMAND",
  "FICTA_REGISTRY_DOPPLER_CONFIGS",
  "FICTA_REGISTRY_DOPPLER_PROJECT",
  "FICTA_REGISTRY_DOPPLER_TIMEOUT_MS",
  "TEST_DOPPLER_API_KEY",
  "DOPPLER_CONFIG",
  "DOPPLER_ENVIRONMENT",
  "DOPPLER_PROJECT",
  "DOPPLER_TOKEN",
  "ANTHROPIC_API_KEY",
  "PATH",
  "PWD",
  "OLDPWD",
  "DB_PWD",
  "ADMINPWD",
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

    expect(() =>
      validatePluginBoundaries([
        {
          kind: "detector",
          name: "bad-policy",
          registryPolicy: { exclusions: [{ id: "raw", kind: "env-name", names: ["NAME"], value: "secret" }] },
          detectText: () => [],
        } as any,
      ]),
    ).toThrow(/unsupported field/);

    expect(() =>
      validatePluginBoundaries([
        {
          kind: "detector",
          name: "bad-env-name",
          registryPolicy: { exclusions: [{ id: "bad", kind: "env-name", names: ["not an env name"], reason: "x" }] },
          detectText: () => [],
        } as any,
      ]),
    ).toThrow(/exact env var names/);
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

  it("refuses a world-writable Doppler executable", () => {
    const bin = mkdtempSync(join(tmpdir(), "ficta-doppler-world-writable-"));
    const command = join(bin, "doppler");
    writeFileSync(command, "#!/bin/sh\nprintf '%s\\n' '{\"DOPPLER_SECRET\":\"should-not-load\"}'\n", { mode: 0o722 });
    chmodSync(command, 0o722);

    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "1";
    process.env.FICTA_REGISTRY_DOPPLER_COMMAND = command;

    const snapshot = loadPluginRegistry();
    const doppler = snapshot.discoveries.find((d) => d.id === "doppler-cli/secrets-download");

    expect(snapshot.values.some((v) => v.value === "should-not-load")).toBe(false);
    expect(doppler?.status).toBe("error");
    expect(doppler?.message).toContain("untrusted Doppler command");
    expect(doppler?.message).toContain("world-writable executable");
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

  it("does not register the shell PWD/OLDPWD (working directory) as a secret-ish value", () => {
    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "1";
    process.env.FICTA_REGISTRY_PROCESS_ENV_MODE = "secret-ish";
    process.env.FICTA_REGISTRY_MIN_LEN = "3";
    process.env.PWD = "/Users/alice/src/secret-looking-project";
    process.env.OLDPWD = "/Users/alice/elsewhere";
    process.env.DB_PWD = "db-password-value";
    process.env.ADMINPWD = "admin-password-value";

    const snapshot = loadPluginRegistry();

    // Only the exact shell working-directory vars are excluded…
    expect(snapshot.values.some((v) => v.name === "PWD")).toBe(false);
    expect(snapshot.values.some((v) => v.name === "OLDPWD")).toBe(false);
    // …every other `PWD`-bearing credential name stays covered, with or without an underscore.
    expect(snapshot.values.some((v) => v.name === "DB_PWD")).toBe(true);
    expect(snapshot.values.some((v) => v.name === "ADMINPWD")).toBe(true);
  });

  it("keeps Doppler metadata env vars out of process-env protection while preserving tokens", () => {
    process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
    process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "1";
    process.env.FICTA_REGISTRY_PROCESS_ENV_MODE = "all";
    process.env.FICTA_REGISTRY_MIN_LEN = "3";
    process.env.DOPPLER_CONFIG = "local-dev-routing-config";
    process.env.DOPPLER_ENVIRONMENT = "dev";
    process.env.DOPPLER_PROJECT = "api-project";
    process.env.DOPPLER_TOKEN = "doppler-token-secret-value";

    const snapshot = loadPluginRegistry();

    expect(snapshot.values.some((v) => v.name === "DOPPLER_CONFIG")).toBe(false);
    expect(snapshot.values.some((v) => v.name === "DOPPLER_ENVIRONMENT")).toBe(false);
    expect(snapshot.values.some((v) => v.name === "DOPPLER_PROJECT")).toBe(false);
    expect(snapshot.values.some((v) => v.name === "DOPPLER_TOKEN")).toBe(true);

    // The exclusion is owned by the built-in Doppler plugin, so it is enforced.
    const rule = snapshot.registryPolicy.exclusions.find((r) => r.id === "doppler-metadata-env-names");
    expect(rule?.trusted).toBe(true);
    expect(snapshot.policyExcluded).toBe(3);
    // All three came from the process-env source, so the count is attributed there.
    expect(snapshot.policyExcludedBySource["process-env"]).toBe(3);
  });

  it("annotates discovery lines with per-source policy exclusions", () => {
    const lines = registryDiscoveryLines(
      [
        {
          id: "known-env-values/process-env",
          plugin: "known-env-values",
          label: "process env",
          status: "loaded",
          valueCount: 5,
        },
      ],
      "  ",
      { "process-env": 2 },
    );

    expect(lines[0]).toContain("(2 excluded by policy)");
  });

  it("records but does not enforce registry exclusions from untrusted (non-built-in) plugins", () => {
    const policyOwner = {
      kind: "detector" as const,
      name: "metadata-owner",
      registryPolicy: {
        exclusions: [
          {
            id: "metadata-name",
            kind: "env-name" as const,
            names: ["PUBLIC_METADATA"],
            reason: "fixture metadata label",
          },
        ],
      },
      detectText: () => [],
    };
    const source = {
      kind: "registry-source" as const,
      name: "fixture-source",
      config: { bindings: [], sections: [], envDefaults: {} },
      setup: { registrySources: () => [] },
      discover: () => [],
      loadValues: () => [
        { name: "PUBLIC_METADATA", value: "metadata-routing-label", source: "fixture" },
        { name: "PRIVATE_TOKEN", value: "fixture-secret-token", source: "fixture" },
      ],
    };

    const snapshot = loadPluginRegistry([policyOwner, source]);

    // The rule is reported (so doctor can surface it) but un-protection is NOT honored for an
    // untrusted plugin: PUBLIC_METADATA stays protected. This is the fail-closed fence.
    const rule = snapshot.registryPolicy.exclusions.find((r) => r.id === "metadata-name");
    expect(rule?.trusted).toBe(false);
    expect(snapshot.policyExcluded).toBe(0);
    expect(snapshot.values.some((value) => value.name === "PUBLIC_METADATA")).toBe(true);
    expect(snapshot.values.some((value) => value.name === "PRIVATE_TOKEN")).toBe(true);
  });

  it("tags exclusions trusted only for plugins core vouches for", () => {
    const owner = {
      kind: "detector" as const,
      name: "owner",
      registryPolicy: { exclusions: [{ id: "x", kind: "env-name" as const, names: ["FOO"], reason: "r" }] },
      detectText: () => [],
    };

    const trusted = buildRegistryPolicy([owner], new Set([owner]));
    expect(trusted.exclusions[0]?.trusted).toBe(true);
    expect(protectedValueExcludedBy({ name: "FOO" }, trusted)).toBeTruthy();

    const untrusted = buildRegistryPolicy([owner], new Set());
    expect(untrusted.exclusions[0]?.trusted).toBe(false);
    expect(protectedValueExcludedBy({ name: "FOO" }, untrusted)).toBeUndefined();
    // Diagnostics may still see untrusted rules via the explicit opt-in.
    expect(protectedValueExcludedBy({ name: "FOO" }, untrusted, { includeUntrusted: true })).toBeTruthy();
  });
});

describe("user exclusion list", () => {
  it("parses, dedupes, and sorts valid env names into a trusted rule", () => {
    const { rule, invalidNames } = parseUserExclusionRule(" BETA , ALPHA ,ALPHA, ");
    expect(invalidNames).toEqual([]);
    expect(rule?.id).toBe(USER_EXCLUSION_RULE_ID);
    expect(rule?.plugin).toBe(USER_EXCLUSION_PLUGIN);
    expect(rule?.trusted).toBe(true);
    expect(rule?.names).toEqual(["ALPHA", "BETA"]);
  });

  it("separates invalid entries and yields no rule when none are valid", () => {
    const { rule, invalidNames } = parseUserExclusionRule("has space, 1LEADING, OK_NAME");
    expect(rule?.names).toEqual(["OK_NAME"]);
    expect(invalidNames).toEqual(["has space", "1LEADING"]);

    const empty = parseUserExclusionRule("bad name, another bad");
    expect(empty.rule).toBeUndefined();
    expect(empty.invalidNames.length).toBe(2);
  });

  it("enforces the user rule at registry load and records safe excluded metadata", () => {
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
    process.env.FICTA_REGISTRY_MIN_LEN = "6";
    process.env.FICTA_REGISTRY_EXCLUDE_NAMES = "AWS_KEY";

    const snapshot = loadPluginRegistry();

    expect(snapshot.values.some((v) => v.name === "AWS_KEY")).toBe(false);
    expect(snapshot.policyExcluded).toBeGreaterThanOrEqual(1);
    const dropped = snapshot.policyExcludedValues.find((d) => d.name === "AWS_KEY");
    expect(dropped?.rule.plugin).toBe(USER_EXCLUSION_PLUGIN);
    expect(dropped?.source).toBe("env-file");
    // The user rule is first in the effective policy so overlaps attribute to the user.
    expect(snapshot.registryPolicy.exclusions[0]?.id).toBe(USER_EXCLUSION_RULE_ID);
    // Safe metadata only — never the underlying value.
    expect(JSON.stringify(snapshot.policyExcludedValues)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("reports invalid names as a non-blocking discovery, not an error", () => {
    process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
    process.env.FICTA_REGISTRY_MIN_LEN = "6";
    process.env.FICTA_REGISTRY_EXCLUDE_NAMES = "not a name";

    const snapshot = loadPluginRegistry();
    const discovery = snapshot.discoveries.find((d) => d.id === "user-config/exclude-names");

    expect(discovery?.status).toBe("available");
    expect(discovery?.message).toContain("not a name");
    expect(snapshot.discoveries.some((d) => d.status === "error")).toBe(false);
  });
});

describe("config-driven detector plugins", () => {
  const detector: FictaPlugin = {
    kind: "detector",
    name: "fixture-pii",
    detectText: () => [],
    config: {
      envDefaults: { FICTA_PII_ENABLED: "0" },
      bindings: [{ env: "FICTA_PII_ENABLED", path: ["registry", "pii", "enabled"], kind: "boolean" }],
      sections: [{ path: ["registry", "pii"], keys: ["enabled"] }],
    },
    setup: {
      registrySources: () => [
        {
          id: "fixture-pii/detector",
          label: "PII detector",
          defaultEnabled: false,
          enabledValues: () => ({ FICTA_PII_ENABLED: "1" }),
          disabledValues: () => ({ FICTA_PII_ENABLED: "0" }),
        },
      ],
    },
    discover: () => [
      { id: "fixture-pii/detector", plugin: "fixture-pii", label: "PII detector", status: "disabled", valueCount: 0 },
    ],
  };

  it("accepts a detector that declares config/setup/discover", () => {
    expect(() => validatePluginBoundaries([detector])).not.toThrow();
  });

  it("surfaces a detector's config bindings, sections, env defaults, and setup source", () => {
    expect(pluginConfigBindings([detector]).map((b) => b.env)).toContain("FICTA_PII_ENABLED");
    expect(pluginConfigSections([detector]).some((s) => s.path.join(".") === "registry.pii")).toBe(true);
    expect(pluginEnvDefaults([detector])).toMatchObject({ FICTA_PII_ENABLED: "0" });
    expect(registrySetupSources({ env: process.env }, [detector]).some((s) => s.id === "fixture-pii/detector")).toBe(
      true,
    );
  });

  it("reports a detector's discovery line at registry load, with no exact values", () => {
    const snapshot = loadPluginRegistry([detector]);
    expect(snapshot.discoveries.some((d) => d.id === "fixture-pii/detector")).toBe(true);
    expect(snapshot.values).toHaveLength(0);
  });

  it("still forbids a detector from declaring loadValues (registry-source-only)", () => {
    expect(() =>
      validatePluginBoundaries([
        { kind: "detector", name: "bad", detectText: () => [], loadValues: () => [] } as unknown as FictaPlugin,
      ]),
    ).toThrow(/kind="registry-source"/);
  });

  it("rejects malformed detector config", () => {
    expect(() =>
      validatePluginBoundaries([
        { kind: "detector", name: "bad-config", detectText: () => [], config: {} } as unknown as FictaPlugin,
      ]),
    ).toThrow(/config\.bindings must be an array/);
  });
});
