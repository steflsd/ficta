import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DetectorPlugin } from "../src/plugins/index.js";

// Regression guard for the multi-turn web-chat flow (thread e95a5872, 2026-07-02): turn 1 sends
// PII, the model *narrates the surrogates it saw* ("whether these FICTA tokens are the final
// values"), the client stores the restored reply, and turn 2 resends the whole restored transcript.
// The detector then tags the word "FICTA" itself (Presidio classed it as a LOCATION), and replacing
// it re-introduced the value inside its own surrogate — tripping the fail-closed leak gate with a
// 403 on every follow-up turn. The fix skips surrogate-token spans in redaction and leak scanning.

const EMAIL = "stef@lsd.example.za";
const PHONE = "+23057054725";
const SURROGATE = /FICTA_[0-9a-f]{32}/;

/** Deterministic stand-in for Presidio: emails + phone + the token-prefix word "FICTA". */
const fixtureDetector: DetectorPlugin = {
  kind: "detector",
  name: "fixture-pii-detector",
  detectText: (text) => {
    const values = new Set<string>();
    for (const m of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []) values.add(m);
    for (const m of text.match(/\+\d{9,14}/g) ?? []) values.add(m);
    if (/(?<![A-Z])FICTA(?!_[0-9a-f])/.test(text)) values.add("FICTA");
    return [...values].map((value) => ({
      name: value === "FICTA" ? "LOCATION" : "CONTACT",
      value,
      source: "fixture-detector",
      kind: "pii" as const,
      confidence: "high" as const,
    }));
  },
};

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

const MANAGED_ENV = ["FICTA_UPSTREAM", "FICTA_PII_ENABLED", "FICTA_LOG_LEVEL", "FICTA_LOG_DIR"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("multi-turn web chat: restored transcript resent through the proxy", () => {
  it("x-ficta-scope pins a per-thread vault and never reaches the upstream", async () => {
    const upstreamScopeHeaders: Array<string | undefined> = [];
    const upstreamBodies: string[] = [];
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        upstreamScopeHeaders.push(req.headers["x-ficta-scope"] as string | undefined);
        upstreamBodies.push(body);
        const token = body.match(/FICTA_[0-9a-f]{32}/)?.[0];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `echo ${token ?? "none"}` } }] }));
      });
    });

    // Turn 1 detects the email; turn 2's detector sees only fresh content ("just checking"), so
    // without the thread vault the resent email would go upstream in the clear.
    const onceDetector: DetectorPlugin = {
      kind: "detector",
      name: "fixture-once-detector",
      detectText: (text) =>
        text.includes(EMAIL)
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

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_PII_ENABLED = "0";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-scopehdr-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [onceDetector] });
      const url = `http://127.0.0.1:${proxy.port}/v1/chat/completions`;
      const headers = { "content-type": "application/json", "x-ficta-scope": "org-local:thread-42" };

      const res1 = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: `mail ${EMAIL}` }] }),
      });
      expect(res1.status).toBe(200);
      const reply1 = (await res1.json()).choices[0].message.content as string;
      expect(reply1).toContain(EMAIL); // token echoed by the model restores in the thread's scope

      // Turn 2: same thread, the incremental sweep gives the detector only the new leaf — the
      // resent email is redacted from the persistent thread vault, not from re-detection.
      const res2 = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "gpt-5-mini",
          messages: [
            { role: "user", content: `mail ${EMAIL}` },
            { role: "assistant", content: `echo ${EMAIL}` },
            { role: "user", content: "just checking" },
          ],
        }),
      });
      expect(res2.status).toBe(200);

      for (const sent of upstreamBodies) expect(sent).not.toContain(EMAIL); // redacted on every turn
      expect(upstreamScopeHeaders).toEqual([undefined, undefined]); // header stripped both turns
    } finally {
      proxy?.close();
      await close(upstream);
    }
  });

  it("turn 2 forwards cleanly after the model narrated its own tokens on turn 1", async () => {
    const upstreamBodies: string[] = [];
    // Turn 1 the fake model does what gpt-5-mini really did: it repeats the two surrogates it was
    // sent and *talks about them as "FICTA tokens"*, planting the token-prefix word in the reply.
    // Turn 2 it answers innocuously.
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        upstreamBodies.push(body);
        const tokens = body.match(/FICTA_[0-9a-f]{32}/g) ?? [];
        const reply =
          upstreamBodies.length === 1
            ? `Got it — Email: ${tokens[0] ?? "?"}, Number: ${tokens[1] ?? "?"}. Tell me whether these FICTA tokens are the final values or placeholders.`
            : "Here is your vCard.";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }));
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_PII_ENABLED = "0"; // fixture detector stands in for the pii plugin
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-multiturn-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [fixtureDetector] });
      const url = `http://127.0.0.1:${proxy.port}/v1/chat/completions`;

      // Turn 1: user shares PII; client receives the RESTORED reply (real values, plus the word
      // "FICTA" from the model's narration) and stores it in the thread.
      const user1 = { role: "user", content: `my email is ${EMAIL}, my number is ${PHONE}` };
      const res1 = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5-mini", messages: [user1] }),
      });
      expect(res1.status).toBe(200);
      const reply1 = (await res1.json()).choices[0].message as { role: string; content: string };
      expect(reply1.content).toContain(EMAIL); // restored for the client
      expect(reply1.content).toContain(PHONE);
      expect(reply1.content).toContain("FICTA tokens"); // the narration that used to poison turn 2
      expect(reply1.content).not.toMatch(SURROGATE);

      // Turn 2: the client resends the whole restored transcript plus a follow-up.
      const res2 = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5-mini",
          messages: [user1, reply1, { role: "user", content: "make the vcard" }],
        }),
      });

      // The regression: this was a 403 ficta_blocked ("1 registered value(s) survived body
      // redaction") because redacting the detected word "FICTA" re-introduced it inside its own
      // surrogate. It must forward and answer normally.
      expect(res2.status).toBe(200);
      expect((await res2.json()).choices[0].message.content).toBe("Here is your vCard.");

      // And the raw PII still never reached the model on either turn.
      for (const sent of upstreamBodies) {
        expect(sent).not.toContain(EMAIL);
        expect(sent).not.toContain(PHONE);
      }
      expect(upstreamBodies).toHaveLength(2);
    } finally {
      proxy?.close();
      await close(upstream);
    }
  });
});
