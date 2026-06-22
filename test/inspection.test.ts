process.env.FICTA_CONFIG_FILE = "0";
process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
process.env.FICTA_REGISTRY_MIN_LEN = "6";

import { describe, expect, it } from "vitest";
import { inspectJson, registeredValues } from "../src/inspection.js";

describe("inspection (exact registered-value reporting)", () => {
  it("loads registered values", () => {
    expect(registeredValues().length).toBeGreaterThanOrEqual(3);
  });

  it("reports name + path for a registered value, and NEVER the value itself", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "tool_result", content: "AWS_KEY=AKIAIOSFODNN7EXAMPLE" }] }],
    };
    const report = inspectJson(body);
    expect(report.hits.length).toBe(1);
    expect(report.hits[0]?.names).toContain("AWS_KEY");
    expect(report.hits[0]?.path).toContain("messages");
    // the safety invariant: the report must not leak the value
    expect(JSON.stringify(report)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("loads quoted multiline .env values as one registered value", () => {
    const pem = "-----BEGIN TEST PRIVATE KEY-----\nabc123multilinefake\n-----END TEST PRIVATE KEY-----";
    expect(registeredValues().some((s) => s.name === "PEM_KEY" && s.value === pem)).toBe(true);
  });

  it("reports object-key hits without leaking the key value in the path", () => {
    const report = inspectJson({ ["prefix-" + "AKIAIOSFODNN7EXAMPLE"]: "value" });
    expect(report.hits.length).toBe(1);
    expect(report.hits[0]?.path).toBe("<key#0>.$key");
    expect(JSON.stringify(report)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("has no hits when no registered value is present", () => {
    expect(inspectJson({ messages: [{ content: "nothing sensitive here" }] }).hits.length).toBe(0);
  });
});
