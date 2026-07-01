import { afterEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import { type DetectorPlugin, dopplerPlugin, type RegistrySourcePlugin } from "../src/plugins/index.js";

const SECRET = "test-secret-value-12345";
const EMAIL = "alice@example.com";

describe("protection engine plugins", () => {
  it("loads exact registry values from a plugin and round-trips them", async () => {
    const plugin: RegistrySourcePlugin = {
      kind: "registry-source",
      name: "fixture-registry",
      config: { bindings: [], sections: [], envDefaults: {} },
      setup: { registrySources: () => [] },
      discover: () => [],
      loadValues: () => [
        { name: "FIXTURE_SECRET", value: SECRET, source: "fixture", kind: "secret", confidence: "exact" },
      ],
    };
    const engine = new ProtectionEngine({ plugins: [plugin] });

    expect(engine.registrySize).toBe(1);
    expect(engine.enabled).toBe(true);

    const redacted = await engine.redactBody(JSON.stringify({ content: `secret=${SECRET}` }));
    expect(redacted.count).toBe(1);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(SECRET);
    expect(redacted.body).toMatch(/FICTA_[0-9a-f]{32}/);
    expect(engine.restoreText(redacted.body)).toContain(SECRET);
  });

  it("isolates detector plugin exceptions", async () => {
    const engine = new ProtectionEngine({
      plugins: [
        {
          kind: "detector",
          name: "throwing-detector",
          detectText: () => {
            throw new Error("boom");
          },
        },
      ],
    });

    expect(await engine.redactBody(JSON.stringify({ content: SECRET }))).toEqual({
      body: JSON.stringify({ content: SECRET }),
      count: 0,
      leaks: 0,
    });
  });

  it("supports request-time detector plugins for future PII-style values", async () => {
    const piiPlugin: DetectorPlugin = {
      kind: "detector",
      name: "fixture-pii-detector",
      detectText: (text) => {
        const emails = new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
        return [...emails].map((email) => ({
          name: "EMAIL",
          value: email,
          source: "fixture-detector",
          kind: "pii",
          confidence: "high",
        }));
      },
    };
    const engine = new ProtectionEngine({ plugins: [piiPlugin] });

    expect(engine.registrySize).toBe(0);
    expect(engine.enabled).toBe(true);

    const redacted = await engine.redactBody(JSON.stringify({ content: `contact ${EMAIL}` }));
    expect(redacted.count).toBe(1);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(EMAIL);
    expect(engine.restoreText(redacted.body)).toContain(EMAIL);
  });

  it("stays disabled with no values and no detector plugins", () => {
    const engine = new ProtectionEngine({ plugins: [] });
    expect(engine.registrySize).toBe(0);
    expect(engine.size).toBe(0);
    expect(engine.enabled).toBe(false);
  });

  describe("trusted registry-policy exclusions reach every vault ingress", () => {
    const POLICY_ENV = [
      "FICTA_REGISTRY_DOPPLER_ENABLED",
      "FICTA_REGISTRY_PROCESS_ENV_ENABLED",
      "FICTA_REGISTRY_ENV_FILE_ENABLED",
    ] as const;
    let saved: Partial<Record<(typeof POLICY_ENV)[number], string>>;

    afterEach(() => {
      for (const key of POLICY_ENV) {
        if (saved?.[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it("drops excluded names from opts.values and detector output but keeps real secrets", async () => {
      saved = Object.fromEntries(POLICY_ENV.map((k) => [k, process.env[k]]));
      // Keep launch sources quiet (no Doppler CLI spawn, no ambient env/.env) so the built-in
      // Doppler plugin contributes only its trusted DOPPLER_CONFIG metadata exclusion.
      process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
      process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";

      const detector: DetectorPlugin = {
        kind: "detector",
        name: "fixture-detector",
        detectText: () => [
          {
            name: "DOPPLER_CONFIG",
            value: "detector-routing-label",
            source: "fixture",
            kind: "secret",
            confidence: "exact",
          },
          {
            name: "OTHER_SECRET",
            value: "real-secret-value-abc",
            source: "fixture",
            kind: "secret",
            confidence: "exact",
          },
        ],
      };

      const engine = new ProtectionEngine({
        plugins: [dopplerPlugin, detector],
        values: [
          {
            name: "DOPPLER_CONFIG",
            value: "opts-routing-label",
            source: "fixture",
            kind: "secret",
            confidence: "exact",
          },
          { name: "KEEP_ME", value: "kept-secret-value-xyz", source: "fixture", kind: "secret", confidence: "exact" },
        ],
      });

      // opts.values: DOPPLER_CONFIG excluded by the trusted Doppler rule, KEEP_ME registered.
      expect(engine.registrySize).toBe(1);

      const body = JSON.stringify({
        content: "detector-routing-label / real-secret-value-abc / opts-routing-label / kept-secret-value-xyz",
      });
      const redacted = await engine.redactBody(body);

      expect(redacted.leaks).toBe(0);
      // Excluded names (from both detector and opts.values) are left intact.
      expect(redacted.body).toContain("detector-routing-label");
      expect(redacted.body).toContain("opts-routing-label");
      // Real secrets are still protected.
      expect(redacted.body).not.toContain("real-secret-value-abc");
      expect(redacted.body).not.toContain("kept-secret-value-xyz");
    });
  });
});
