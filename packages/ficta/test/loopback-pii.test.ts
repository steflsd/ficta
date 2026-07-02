import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { piiPlugin } from "../src/plugins/index.js";

// CI-safe end-to-end proof: drive detected PII (not registered secrets) through the *real* proxy
// HTTP handler — detect → tokenize → wire → fake-model reply → restore → client. No API key and no
// network egress: the "upstream" is a loopback node:http server. This is the regression guard behind
// the pilot claim that PII never crosses the wire in the clear and comes back restored, and that one
// request's detected PII can never be restored into another request's response. Engine-level scope
// semantics live in scope.test.ts; this asserts the same guarantees survive the full transport.

const EMAIL = "jane.doe@example.com";
const SSN = "123-45-6789";
const CARD = "4111 1111 1111 1111"; // Luhn-valid test card
const SURROGATE = /FICTA_[0-9a-f]{32}/;
const SURROGATE_G = /FICTA_[0-9a-f]{32}/g;

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

/** Distinct FICTA_ surrogates present in a chunk of wire text. */
function tokensIn(text: string): Set<string> {
  return new Set(text.match(SURROGATE_G) ?? []);
}

/** Env keys these tests mutate; captured/restored around each case so ordering never leaks state. */
const MANAGED_ENV = [
  "FICTA_UPSTREAM",
  "FICTA_PII_ENABLED",
  // Pinned to regex so the round-trip is deterministic and never reaches for a Presidio sidecar,
  // regardless of any ambient FICTA_PII_RECOGNIZERS in the developer's/CI environment.
  "FICTA_PII_RECOGNIZERS",
  "FICTA_LOG_LEVEL",
  "FICTA_LOG_DIR",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("loopback PII round-trip through the real proxy", () => {
  it("buffered JSON: redacts PII on egress, restores it for the client, and logs symmetric counts", async () => {
    const saved = snapshotEnv();
    let received = "";
    // The fake model echoes the (already-redacted) request body back as its JSON reply, so its
    // response carries exactly the surrogates it was sent — the client-facing restore must turn them
    // back into the real values.
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    // pino logs to stderr (JSON lines when not a TTY, as in tests); capture them.
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(String(chunk));
      return true;
    });
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_PII_ENABLED = "1";
      process.env.FICTA_PII_RECOGNIZERS = "regex";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-loopback-"));
      // Intentionally at info (not silent): this case also asserts the 🔒/♻️ console lines fire end-to-end.
      process.env.FICTA_LOG_LEVEL = "info";

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [piiPlugin] });

      stderrLines.length = 0; // drop the startup banner; keep only per-request lines
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [{ role: "user", content: `Contact ${EMAIL}, SSN ${SSN}, card ${CARD}` }],
        }),
      });
      const clientText = await res.text();

      expect(res.status).toBe(200);

      // Egress: none of the three PII literals reached the model; three distinct tokens did.
      expect(received).not.toContain(EMAIL);
      expect(received).not.toContain(SSN);
      expect(received).not.toContain(CARD);
      expect(tokensIn(received).size).toBe(3);

      // Ingress: every value restored for the client, no placeholder left behind.
      expect(clientText).toContain(EMAIL);
      expect(clientText).toContain(SSN);
      expect(clientText).toContain(CARD);
      expect(clientText).not.toMatch(SURROGATE);

      // Symmetric accounting: egress count (also in stats) and the restore-count log line.
      const logged = stderrLines.join("");
      expect(logged).toMatch(/🔒 kept 3 body value\(s\)/);
      expect(logged).toContain('"kept":3');
      expect(logged).toMatch(/♻️ restored 3 value\(s\) in response/);
      expect(logged).toContain('"restored":3');
      expect(proxy.protectionStats().totals.keptOutOfModelValues).toBe(3);
    } finally {
      stderrSpy.mockRestore();
      proxy?.close();
      await close(upstream);
      restoreEnv(saved);
    }
  });

  it("SSE stream: restores a surrogate the model streamed back inside a delta", async () => {
    const saved = snapshotEnv();
    let received = "";
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received = body;
        const token = body.match(SURROGATE)?.[0] ?? "";
        const sse = `data: ${JSON.stringify({
          choices: [{ delta: { content: `Your email is ${token}.` } }],
        })}\n\ndata: [DONE]\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_PII_ENABLED = "1";
      process.env.FICTA_PII_RECOGNIZERS = "regex";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-loopback-"));
      process.env.FICTA_LOG_LEVEL = "silent";

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [piiPlugin] });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: `Contact ${EMAIL}` }] }),
      });
      const clientText = await res.text();
      const delta = [...clientText.matchAll(/^data: (.+)$/gm)]
        .flatMap((m) => {
          try {
            return [JSON.parse(m[1] ?? "{}")];
          } catch {
            return []; // the [DONE] sentinel is not JSON
          }
        })
        .map((event) => event?.choices?.[0]?.delta?.content ?? "")
        .join("");

      expect(res.status).toBe(200);
      expect(received).not.toContain(EMAIL); // redacted on egress
      expect(received).toMatch(SURROGATE);
      expect(delta).toContain(EMAIL); // restored in the streamed delta
      expect(delta).not.toMatch(SURROGATE); // no placeholder leaked to the client
    } finally {
      proxy?.close();
      await close(upstream);
      restoreEnv(saved);
    }
  });

  it("cross-request isolation: request B never restores request A's PII (the gateway's core claim)", async () => {
    const saved = snapshotEnv();
    let received = "";
    // When forceReply is set, the model returns it verbatim regardless of the request — this is how
    // we simulate a response that (coincidentally or maliciously) echoes a token minted for a *prior*
    // request. It must NOT be restored, because that request's ephemeral scope closed with it.
    let forceReply: string | null = null;
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received = body;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(forceReply ?? body);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_PII_ENABLED = "1";
      process.env.FICTA_PII_RECOGNIZERS = "regex";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-loopback-"));
      process.env.FICTA_LOG_LEVEL = "silent";

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [piiPlugin] });

      // Request A carries the email; the echoed reply restores it within A's own scope.
      const resA = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: `Contact ${EMAIL}` }] }),
      });
      const textA = await resA.text();
      const tokenForEmail = received.match(SURROGATE)?.[0];
      expect(tokenForEmail).toBeTruthy();
      expect(textA).toContain(EMAIL); // A round-trips normally

      // Request B contains no PII, but the model's reply echoes A's token. B's fresh scope has no
      // mapping for it, so restore must leave the token untouched and never surface A's email.
      forceReply = JSON.stringify({ note: `an unrelated response mentioning ${tokenForEmail}` });
      const resB = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "just a normal message" }] }),
      });
      const textB = await resB.text();

      expect(resB.status).toBe(200);
      expect(textB).toContain(tokenForEmail ?? "<none>"); // token passes through unrestored
      expect(textB).not.toContain(EMAIL); // A's PII never leaks into B's response
    } finally {
      proxy?.close();
      await close(upstream);
      restoreEnv(saved);
    }
  });
});
