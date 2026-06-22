import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import type { FictaPlugin } from "../src/plugins/index.js";

const SECRET = "test-secret-value-12345";
const EMAIL = "alice@example.com";

describe("protection engine plugins", () => {
  it("loads exact registry values from a plugin and round-trips them", () => {
    const plugin: FictaPlugin = {
      name: "fixture-registry",
      loadValues: () => [
        { name: "FIXTURE_SECRET", value: SECRET, source: "fixture", kind: "secret", confidence: "exact" },
      ],
    };
    const engine = new ProtectionEngine({ plugins: [plugin] });

    expect(engine.registrySize).toBe(1);
    expect(engine.enabled).toBe(true);

    const redacted = engine.redactBody(JSON.stringify({ content: `secret=${SECRET}` }));
    expect(redacted.count).toBe(1);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(SECRET);
    expect(redacted.body).toMatch(/FICTA_[0-9a-f]{32}/);
    expect(engine.restoreText(redacted.body)).toContain(SECRET);
  });

  it("supports request-time detector plugins for future PII-style values", () => {
    const piiPlugin: FictaPlugin = {
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

    const redacted = engine.redactBody(JSON.stringify({ content: `contact ${EMAIL}` }));
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
});
