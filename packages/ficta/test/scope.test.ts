import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import type { DetectorPlugin } from "../src/plugins/index.js";

const EMAIL = "alice@example.com";
const SURROGATE = /FICTA_[0-9a-f]{32}/;

/** Inline email detector — deterministic and env-free, so these tests exercise the scope machinery
 * (not the built-in PII recognizer's regex details). */
const emailDetector: DetectorPlugin = {
  kind: "detector",
  name: "fixture-email-detector",
  detectText: (text) =>
    [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])].map((value) => ({
      name: "EMAIL",
      value,
      source: "fixture-detector",
      kind: "pii" as const,
      confidence: "high" as const,
    })),
};

/** Detector that matches a bare 16-digit run as-is, so the numeric-vs-string-leaf test doesn't depend
 * on the built-in Luhn recognizer's separator handling. */
const CARD = "4111111111111111";
const cardDetector: DetectorPlugin = {
  kind: "detector",
  name: "fixture-card-detector",
  detectText: (text) =>
    text.includes(CARD)
      ? [{ name: "card", value: CARD, source: "fixture-detector", kind: "pii" as const, confidence: "high" as const }]
      : [],
};

describe("request scopes isolate detected PII", () => {
  it("never restores one scope's detected value into another scope's response (cross-client leak fix)", async () => {
    const engine = new ProtectionEngine({ plugins: [emailDetector] });

    // Scope A detects the email and mints a surrogate for it.
    const scopeA = engine.beginRequest();
    const redacted = await scopeA.redactBodyDetailed(JSON.stringify({ content: `contact ${EMAIL}` }));
    const surrogate = redacted.body.match(SURROGATE)?.[0];
    expect(surrogate).toBeTruthy();
    expect(redacted.body).not.toContain(EMAIL);

    // Scope B never saw the email. If B's *response* happens to carry A's surrogate, B's restore must
    // leave it untouched — handing B client A's PII is exactly the leak this design prevents.
    const scopeB = engine.beginRequest();
    expect(scopeB.restoreText(surrogate ?? "")).toBe(surrogate);
    expect(scopeB.restoreText(surrogate ?? "")).not.toContain(EMAIL);

    // A's own restore still round-trips within its scope.
    expect(scopeA.restoreText(surrogate ?? "")).toContain(EMAIL);
  });

  it("does not persist detected PII into the shared permanent vault (ephemerality)", async () => {
    const engine = new ProtectionEngine({ plugins: [emailDetector] });
    expect(engine.size).toBe(0);

    const scope = engine.beginRequest();
    const redacted = await scope.redactBodyDetailed(JSON.stringify({ content: `contact ${EMAIL}` }));
    expect(redacted.count).toBe(1);
    scope.restoreText(redacted.body); // full redact→restore cycle

    // The detected value lived and died with the scope; the permanent vault never grew.
    expect(engine.size).toBe(0);

    // A brand-new scope has no memory of it either.
    const fresh = engine.beginRequest();
    const surrogate = redacted.body.match(SURROGATE)?.[0] ?? "";
    expect(fresh.restoreText(surrogate)).toBe(surrogate);
  });

  it("mints the same surrogate for the same value across independent scopes (cross-turn consistency)", async () => {
    const engine = new ProtectionEngine({ plugins: [emailDetector] });

    const a = await engine.beginRequest().redactBodyDetailed(JSON.stringify({ content: EMAIL }));
    const b = await engine.beginRequest().redactBodyDetailed(JSON.stringify({ content: EMAIL }));

    const surA = a.body.match(SURROGATE)?.[0];
    const surB = b.body.match(SURROGATE)?.[0];
    // Deterministic HMAC surrogates keep the token stable turn-to-turn, so a resent conversation
    // renders consistently even though each request gets a fresh, isolated scope.
    expect(surA).toBeTruthy();
    expect(surA).toBe(surB);
  });
});

describe("detection matches the redactable surface (numeric-JSON PII, TODO #2)", () => {
  it("redacts a value that appears as a JSON string leaf", async () => {
    const engine = new ProtectionEngine({ plugins: [cardDetector] });
    const redacted = await engine.beginRequest().redactBodyDetailed(JSON.stringify({ card: CARD }));

    expect(redacted.count).toBe(1);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(CARD);
    expect(redacted.body).toMatch(SURROGATE);
  });

  it("leaves a value that appears only as a JSON number leaf untouched — detected==redactable, so no fail-closed reject", async () => {
    const engine = new ProtectionEngine({ plugins: [cardDetector] });
    // `{"card": 4111111111111111}` — the digits are a JSON *number*, not a string leaf, so a string
    // surrogate cannot replace them without changing the leaf's type. Because detection runs over the
    // same string leaves redaction can rewrite, the number is neither detected nor flagged as a leak:
    // the request forwards unchanged instead of tripping the fail-closed gate on un-removable PII.
    const body = `{"card": ${CARD}}`;
    const redacted = await engine.beginRequest().redactBodyDetailed(body);

    expect(redacted.count).toBe(0);
    expect(redacted.leaks).toBe(0);
    expect(redacted.body).toBe(body);
  });
});
