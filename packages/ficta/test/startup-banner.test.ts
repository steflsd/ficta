import { describe, expect, it } from "vitest";
import type { PluginDiscovery, RegistryPolicy } from "../src/plugins/index.js";
import { renderStartupBanner, shouldPrintStartupDiagnostics } from "../src/startup-banner.js";

const discoveries: PluginDiscovery[] = [
  {
    id: "doppler-cli/secrets-download",
    plugin: "doppler-cli",
    label: "Doppler CLI",
    status: "loaded",
    valueCount: 34,
    message:
      "loaded current config via `doppler secrets download --no-file --format json`; skipped 4 shorter than 8 chars",
    details: ["current: 34 loaded"],
  },
  {
    id: "known-env-values/env-file",
    plugin: "known-env-values",
    label: "env files",
    status: "loaded",
    valueCount: 4,
    message: "read 1 file(s)",
    details: [".env: not found", ".env.local: 4 loaded"],
  },
  {
    id: "known-env-values/process-env",
    plugin: "known-env-values",
    label: "process env",
    status: "loaded",
    valueCount: 10,
    message: "enabled for secret-ish env names; skipped 4 shorter than 8 chars, 3 empty",
  },
];

describe("startup banner", () => {
  it("renders a compact default summary", () => {
    const rendered = renderStartupBanner({
      protectedValues: 47,
      agentCommand: "pi",
      baseUrl: "http://127.0.0.1:59717",
      discoveries,
    });

    expect(rendered).toBe(
      "🔒 ficta ready — 47 protected values (48 loaded before dedupe)\n" +
        "   pi → http://127.0.0.1:59717\n" +
        "   sources: Doppler 34, .env.local 4, process env 10\n" +
        "   pii: off\n",
    );
    expect(rendered).not.toContain("not found");
    expect(rendered).not.toContain("doppler secrets download");
  });

  it("prints detailed registry discovery only in verbose mode", () => {
    const rendered = renderStartupBanner({
      protectedValues: 47,
      agentCommand: "pi",
      baseUrl: "http://127.0.0.1:59717",
      discoveries,
      verbose: true,
    });

    expect(rendered).toContain("   source details:\n");
    expect(rendered).toContain("✓ Doppler CLI (34 values)");
    expect(rendered).toContain(".env: not found");
    expect(rendered).toContain("doppler secrets download");
  });

  it("reports registry-policy exclusions separately from dedupe", () => {
    const policy: RegistryPolicy = {
      exclusions: [
        {
          plugin: "doppler-cli",
          trusted: true,
          id: "doppler-metadata-env-names",
          kind: "env-name",
          names: ["DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT", "DOPPLER_PROJECT"],
          reason: "Doppler routing/config metadata env vars are not secret material",
        },
      ],
    };
    const rendered = renderStartupBanner({
      protectedValues: 92,
      agentCommand: "claude",
      baseUrl: "http://127.0.0.1:59717",
      discoveries: [
        {
          id: "known-env-values/process-env",
          plugin: "known-env-values",
          label: "process env",
          status: "loaded",
          valueCount: 95,
        },
      ],
      policyExcluded: 3,
      policyExcludedBySource: { "process-env": 3 },
      registryPolicy: policy,
    });

    expect(rendered).toContain("3 excluded by registry policy");
    expect(rendered).not.toContain("before dedupe");
    // The source line itself reconciles, not just the headline.
    expect(rendered).toContain("process env 95 (3 excluded)");
  });

  it("hides untrusted, not-enforced rules from the verbose banner", () => {
    const policy: RegistryPolicy = {
      exclusions: [
        {
          plugin: "third-party",
          trusted: false,
          id: "x",
          kind: "env-name",
          names: ["SOME_NAME"],
          reason: "declared by an untrusted plugin",
        },
      ],
    };
    const rendered = renderStartupBanner({
      protectedValues: 1,
      agentCommand: "claude",
      baseUrl: "http://127.0.0.1:59717",
      discoveries: [
        {
          id: "known-env-values/process-env",
          plugin: "known-env-values",
          label: "process env",
          status: "loaded",
          valueCount: 1,
        },
      ],
      registryPolicy: policy,
      verbose: true,
    });

    // Untrusted rules are diagnostic noise for end users; only doctor surfaces them.
    expect(rendered).not.toContain("registry policy exclusions:");
    expect(rendered).not.toContain("SOME_NAME");
  });

  it("shows the policy exclusion breakdown in verbose mode", () => {
    const policy: RegistryPolicy = {
      exclusions: [
        {
          plugin: "doppler-cli",
          trusted: true,
          id: "doppler-metadata-env-names",
          kind: "env-name",
          names: ["DOPPLER_CONFIG"],
          reason: "routing metadata",
        },
      ],
    };
    const rendered = renderStartupBanner({
      protectedValues: 1,
      agentCommand: "claude",
      baseUrl: "http://127.0.0.1:59717",
      discoveries: [
        {
          id: "known-env-values/process-env",
          plugin: "known-env-values",
          label: "process env",
          status: "loaded",
          valueCount: 2,
        },
      ],
      policyExcluded: 1,
      registryPolicy: policy,
      verbose: true,
    });

    expect(rendered).toContain("registry policy exclusions:");
    expect(rendered).toContain("doppler-cli: DOPPLER_CONFIG");
  });

  it("calls out errored sources without dumping full details", () => {
    const rendered = renderStartupBanner({
      protectedValues: 1,
      agentCommand: "claude",
      baseUrl: "http://127.0.0.1:12345",
      discoveries: [
        { id: "ok", plugin: "test", label: "env files", status: "loaded", valueCount: 1 },
        { id: "bad", plugin: "test", label: "Doppler CLI", status: "error", valueCount: 0, message: "boom" },
      ],
    });

    expect(rendered).toContain("attention: 1 registry source errored");
    expect(rendered).not.toContain("boom");
  });

  it("reports the per-session PII posture from the detector discovery", () => {
    const base = { protectedValues: 0, agentCommand: "claude", baseUrl: "http://127.0.0.1:1" };
    const active = [{ id: "pii/detector", plugin: "pii", label: "PII detector", status: "active" as const }];

    // Active without an explicit posture defaults to the fail-open wording.
    const on = renderStartupBanner({ ...base, discoveries: active });
    expect(on).toContain("   pii: on (best-effort, skips on backend outage)\n");

    const failOpen = renderStartupBanner({ ...base, discoveries: active, piiFailClosed: false });
    expect(failOpen).toContain("   pii: on (best-effort, skips on backend outage)\n");

    const failClosed = renderStartupBanner({ ...base, discoveries: active, piiFailClosed: true });
    expect(failClosed).toContain("   pii: on (best-effort, blocks on backend outage)\n");

    const off = renderStartupBanner({
      ...base,
      discoveries: [{ id: "pii/detector", plugin: "pii", label: "PII detector", status: "disabled" }],
      // A posture on a disabled detector is irrelevant — the line stays a bare "off".
      piiFailClosed: true,
    });
    expect(off).toContain("   pii: off\n");
  });

  it("suppresses launch diagnostics only for default interactive TTY runs", () => {
    expect(shouldPrintStartupDiagnostics({ verbose: false, stderrIsTTY: true })).toBe(false);
    expect(shouldPrintStartupDiagnostics({ verbose: true, stderrIsTTY: true })).toBe(true);
    expect(shouldPrintStartupDiagnostics({ verbose: false, stderrIsTTY: false })).toBe(true);
    expect(shouldPrintStartupDiagnostics({ verbose: false })).toBe(true);
  });
});
