import { describe, expect, it } from "vitest";
import { ProtectionEngine } from "../src/engine.js";
import type { DetectorPlugin } from "../src/plugins/index.js";
import { DetectorUnavailableError } from "../src/redaction-engine.js";

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

/** Detector that tags the literal word "FICTA" — mimicking Presidio classifying the surrogate
 * prefix as a LOCATION after the model narrated its own tokens ("whether these FICTA tokens are
 * the final values"), which is exactly what a restored multi-turn web transcript resends. */
const fictaWordDetector: DetectorPlugin = {
  kind: "detector",
  name: "fixture-ficta-word-detector",
  detectText: (text) =>
    /(?<![A-Z])FICTA(?!_[0-9a-f])/.test(text)
      ? [
          {
            name: "LOCATION",
            value: "FICTA",
            source: "fixture-detector",
            kind: "pii" as const,
            confidence: "high" as const,
          },
        ]
      : [],
};

describe("surrogate self-collision: detected values that match inside token text", () => {
  it("a detected value equal to the token prefix redacts without tripping the fail-closed gate", async () => {
    const engine = new ProtectionEngine({ plugins: [emailDetector, fictaWordDetector] });
    const scope = engine.beginRequest();

    // The regression shape: restored turn-1 assistant text mentions "FICTA tokens" alongside real
    // PII; the follow-up turn resends it all. Replacing "FICTA" re-introduces the value inside its
    // own surrogate, so an unguarded leak scan flags it and 403s every follow-up turn.
    const body = JSON.stringify({
      messages: [
        { role: "user", content: `my email is ${EMAIL}` },
        {
          role: "assistant",
          content: `Got it — tell me whether these FICTA tokens are the final values.\nEmail: ${EMAIL}`,
        },
        { role: "user", content: "make the vcard" },
      ],
    });
    const redacted = await scope.redactBodyDetailed(body);

    expect(redacted.leaks).toBe(0);
    expect(redacted.body).not.toContain(EMAIL);
  });

  it("does not corrupt sibling surrogate tokens when a detected value matches their prefix", async () => {
    const engine = new ProtectionEngine({ plugins: [emailDetector, fictaWordDetector] });
    const scope = engine.beginRequest();

    const body = JSON.stringify({ content: `whether these FICTA tokens hide ${EMAIL}` });
    const redacted = await scope.redactBodyDetailed(body);

    // The email's token must survive the "FICTA" replacement pass intact: restore must recover the
    // email exactly, not a half-rewritten token ("FICTA_<hex-of-FICTA>_<tail-of-email-token>").
    expect(scope.restoreJson(redacted.body)).toBe(body);
  });

  it("leaves a client-sent surrogate token opaque when a detected value matches inside its hex", async () => {
    const hexy: DetectorPlugin = {
      kind: "detector",
      name: "fixture-hexy-detector",
      detectText: (text) =>
        text.includes("cafe")
          ? [
              {
                name: "WORD",
                value: "cafe",
                source: "fixture-detector",
                kind: "pii" as const,
                confidence: "high" as const,
              },
            ]
          : [],
    };
    const engine = new ProtectionEngine({ plugins: [hexy] });
    const scope = engine.beginRequest();

    // A stale token from an earlier turn (e.g. one restore missed) whose hex happens to contain the
    // detected word. Rewriting inside it would corrupt it; matching inside it is not a leak.
    const staleToken = "FICTA_cafe0123456789abcdef0123456789ab";
    const body = JSON.stringify({ content: `token ${staleToken} and a cafe downtown` });
    const redacted = await scope.redactBodyDetailed(body);

    expect(redacted.leaks).toBe(0);
    expect(redacted.body).toContain(staleToken); // token untouched
    expect(redacted.body).not.toContain("cafe downtown"); // prose occurrence still redacted
  });
});

describe("keyed scopes persist detected PII across a thread's requests", () => {
  it("a value detected on turn 1 stays redacted on turn 2 even when the detector misses it", async () => {
    // Detector only fires when the marker is present — simulating Presidio detecting a value in one
    // request's context but missing it in another's.
    const flaky: DetectorPlugin = {
      kind: "detector",
      name: "fixture-flaky-detector",
      detectText: (text) =>
        text.includes("DETECT-NOW") && text.includes(EMAIL)
          ? [
              {
                name: "EMAIL",
                value: EMAIL,
                source: "fixture-detector",
                kind: "pii" as const,
                confidence: "high" as const,
              },
            ]
          : [],
    };
    const engine = new ProtectionEngine({ plugins: [flaky] });

    const turn1 = await engine
      .beginRequest("org:thread-1")
      .redactBodyDetailed(JSON.stringify({ content: `DETECT-NOW contact ${EMAIL}` }));
    expect(turn1.count).toBe(1);
    expect(turn1.body).not.toContain(EMAIL);

    // Turn 2: no marker, so the detector returns nothing — the persistent thread vault must still
    // redact the known value. (An unkeyed scope would forward it in the clear here.)
    const turn2 = await engine
      .beginRequest("org:thread-1")
      .redactBodyDetailed(JSON.stringify({ content: `follow-up mentioning ${EMAIL}` }));
    expect(turn2.body).not.toContain(EMAIL);
    expect(turn2.leaks).toBe(0);

    const unkeyed = await engine
      .beginRequest()
      .redactBodyDetailed(JSON.stringify({ content: `follow-up mentioning ${EMAIL}` }));
    expect(unkeyed.body).toContain(EMAIL); // contrast: fresh scope has no memory and nothing fires
  });

  it("different keys stay isolated: one thread's values never restore in another's scope", async () => {
    const engine = new ProtectionEngine({ plugins: [emailDetector] });

    const a = engine.beginRequest("org:thread-a");
    const redacted = await a.redactBodyDetailed(JSON.stringify({ content: EMAIL }));
    const surrogate = redacted.body.match(SURROGATE)?.[0] ?? "";
    expect(surrogate).toBeTruthy();

    const b = engine.beginRequest("org:thread-b");
    expect(b.restoreText(surrogate)).toBe(surrogate); // opaque across keys

    const a2 = engine.beginRequest("org:thread-a");
    expect(a2.restoreText(surrogate)).toContain(EMAIL); // later turn of the same thread restores
  });

  it("detects incrementally: leaves already swept are not re-sent to detectors", async () => {
    const seenTexts: string[] = [];
    const recording: DetectorPlugin = {
      kind: "detector",
      name: "fixture-recording-detector",
      detectText: (text) => {
        seenTexts.push(text);
        return [];
      },
    };
    const engine = new ProtectionEngine({ plugins: [recording] });

    const turn1 = JSON.stringify({ messages: [{ role: "user", content: "hello world" }] });
    await engine.beginRequest("org:thread-inc").redactBodyDetailed(turn1);

    const turn2 = JSON.stringify({
      messages: [
        { role: "user", content: "hello world" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "new question" },
      ],
    });
    await engine.beginRequest("org:thread-inc").redactBodyDetailed(turn2);

    // Turn 2's detector input contains only content the scope hasn't swept before.
    expect(seenTexts[1]).not.toContain("hello world");
    expect(seenTexts[1]).toContain("hi there");
    expect(seenTexts[1]).toContain("new question");

    // Fully-repeated content → detectors are not called at all (empty text short-circuits).
    seenTexts.length = 0;
    await engine.beginRequest("org:thread-inc").redactBodyDetailed(turn2);
    expect(seenTexts).toHaveLength(0);
  });

  it("does not mark content swept when a fail-open detector was unavailable", async () => {
    let unavailable = true;
    const seenTexts: string[] = [];
    const flaky: DetectorPlugin = {
      kind: "detector",
      name: "fixture-outage-detector",
      failClosed: () => false,
      detectText: (text) => {
        if (unavailable) throw new DetectorUnavailableError("fixture-outage-detector", "sidecar down");
        seenTexts.push(text);
        return [];
      },
    };
    const engine = new ProtectionEngine({ plugins: [flaky] });
    const body = JSON.stringify({ content: "needs a scan" });

    await engine.beginRequest("org:thread-out").redactBodyDetailed(body); // outage: swept nothing
    unavailable = false;
    await engine.beginRequest("org:thread-out").redactBodyDetailed(body);

    // The recovered detector gets a full pass at the content the outage skipped.
    expect(seenTexts).toHaveLength(1);
    expect(seenTexts[0]).toContain("needs a scan");
  });
});
