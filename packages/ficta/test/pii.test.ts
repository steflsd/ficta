import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import { type ProtectedValue, piiPlugin } from "../src/plugins/index.js";
import { regexRecognizer } from "../src/plugins/pii/regex-recognizer.js";

const EMAIL = "alice@example.com";
const SSN = "123-45-6789";
const VISA = "4111 1111 1111 1111"; // Luhn-valid test card number
const NOT_A_CARD = "1234 5678 9012 3456"; // 16 digits, fails Luhn

describe("pii regex recognizer", () => {
  it("detects email, US SSN, and Luhn-valid card numbers", () => {
    const found = regexRecognizer.detect(`contact ${EMAIL}, ssn ${SSN}, card ${VISA}`, {
      surface: "body",
    }) as ProtectedValue[];
    const byCategory = Object.fromEntries(found.map((v) => [v.name, v.value]));

    expect(byCategory.email).toBe(EMAIL);
    expect(byCategory["us-ssn"]).toBe(SSN);
    expect(byCategory["credit-card"]).toBe(VISA);
    for (const value of found) expect(value.kind).toBe("pii");
  });

  it("rejects digit runs that fail the Luhn check", () => {
    const found = regexRecognizer.detect(`card ${NOT_A_CARD}`, { surface: "body" }) as ProtectedValue[];
    expect(found.some((v) => v.name === "credit-card")).toBe(false);
  });

  it("does not absorb a trailing separator into the card value", () => {
    const found = regexRecognizer.detect(`card ${VISA} expires soon`, { surface: "body" }) as ProtectedValue[];
    // The match must end on the last digit — no trailing space pulled in (would mangle vendor text).
    expect(found.find((v) => v.name === "credit-card")?.value).toBe(VISA);
  });
});

describe("pii detector plugin", () => {
  const ENV = "FICTA_PII_ENABLED";
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it("is disabled by default (no detections)", async () => {
    delete process.env[ENV];
    expect(await piiPlugin.detectText?.(`email ${EMAIL}`, { surface: "body" })).toEqual([]);
  });

  it("detects and round-trips PII through the engine when enabled", async () => {
    process.env[ENV] = "1";
    const engine = new ProtectionEngine({ plugins: [piiPlugin] });
    const body = JSON.stringify({ content: `email ${EMAIL}` });

    const redacted = await engine.redactBodyDetailed(body);
    expect(redacted.count).toBe(1);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(EMAIL);
    expect(redacted.body).toMatch(/FICTA_[0-9a-f]{32}/);
    expect(engine.restoreText(redacted.body)).toContain(EMAIL);
  });

  it("reports `protecting` only when actually active, not merely present", () => {
    delete process.env[ENV];
    const off = new ProtectionEngine({ plugins: [piiPlugin] });
    expect(off.enabled).toBe(true); // detector is present
    expect(off.protecting).toBe(false); // ...but disabled → pure passthrough, banner must not claim redaction

    process.env[ENV] = "1";
    const on = new ProtectionEngine({ plugins: [piiPlugin] });
    expect(on.protecting).toBe(true);
  });

  it("declares a config binding and reports its status via discover()", () => {
    expect(piiPlugin.config?.bindings.map((b) => b.env)).toContain(ENV);

    process.env[ENV] = "0";
    expect(piiPlugin.discover?.()[0]?.status).toBe("disabled");
    process.env[ENV] = "1";
    expect(piiPlugin.discover?.()[0]?.status).toBe("available");
  });
});
