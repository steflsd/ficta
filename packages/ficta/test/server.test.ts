import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RegistrySourcePlugin } from "../src/plugins/index.js";

const AWS = "AKIAIOSFODNN7EXAMPLE";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function anthropicInputDelta(index: number, partial_json: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json },
  })}\n\n`;
}

describe("proxy hardening", () => {
  it("does not write protected literals into safe metadata logs", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_PROCESS_ENV_ENABLED: process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      const logDir = mkdtempSync(join(tmpdir(), "ficta-safe-meta-"));
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
      process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
      process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
      process.env.FICTA_REGISTRY_MIN_LEN = "6";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = logDir;

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const unknownRes = await fetch(`http://127.0.0.1:${proxy.port}/new-provider/unknown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [AWS]: "secret in a key", message: "safe" }),
      });
      expect(unknownRes.status).toBe(200);
      await unknownRes.text();

      const knownRes = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: AWS, messages: [] }),
      });
      expect(knownRes.status).toBe(200);
      await knownRes.text();

      const run = readdirSync(logDir).find((name) => name.startsWith("run-"));
      expect(run).toBeTruthy();
      const meta = readdirSync(join(logDir, run ?? ""))
        .filter((name) => name.endsWith(".meta.json"))
        .map((name) => readFileSync(join(logDir, run ?? "", name), "utf8"))
        .join("\n");

      expect(meta).not.toContain(AWS);
      expect(meta).toContain('"keyCount"');
      expect(meta).toContain('"modelSet"');

      const statsText = readFileSync(join(logDir, run ?? "", "stats.json"), "utf8");
      const stats = JSON.parse(statsText) as {
        totals: {
          affectedRequests: number;
          redactedValues: number;
          keptOutOfModelValues: number;
          blockedRequests: number;
        };
        byModel: Array<{ name: string; keptOutOfModelValues: number }>;
        bySurface: Array<{ name: string; redactedValues: number }>;
        byLabel: Array<{ name: string; source: string; redactedValues: number }>;
      };
      expect(statsText).not.toContain(AWS);
      expect(stats.totals).toMatchObject({
        affectedRequests: 2,
        redactedValues: 2,
        keptOutOfModelValues: 2,
        blockedRequests: 0,
      });
      expect(stats.byModel).toContainEqual(expect.objectContaining({ name: "<redacted>", keptOutOfModelValues: 1 }));
      expect(stats.bySurface).toContainEqual(expect.objectContaining({ name: "body", redactedValues: 2 }));
      expect(stats.byLabel).toContainEqual(
        expect.objectContaining({ name: "AWS_KEY", source: "env-file", redactedValues: 2 }),
      );
      expect(proxy.protectionStats().totals.keptOutOfModelValues).toBe(2);
      expect(proxy.statsSummary()).toContain("stats.json");
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("fail-closes instead of forwarding registered numeric JSON primitives", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let upstreamHit = false;
    const upstream = createServer((_req, res) => {
      upstreamHit = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const numericPlugin: RegistrySourcePlugin = {
      kind: "registry-source",
      name: "numeric-fixture",
      config: { bindings: [], sections: [], envDefaults: {} },
      setup: { registrySources: () => [] },
      discover: () => [],
      loadValues: () => [
        {
          name: "NUMERIC_SECRET",
          value: "12345678",
          source: "fixture",
          kind: "secret",
          confidence: "exact",
        },
      ],
    };

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0, plugins: [numericPlugin] });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: 12345678 }),
      });
      const payload = (await res.json()) as { error?: { type?: string } };

      expect(res.status).toBe(403);
      expect(payload.error?.type).toBe("ficta_blocked");
      expect(upstreamHit).toBe(false);
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("preloads Doppler CLI values and redacts them when an agent later emits Doppler output", async () => {
    const canary = "ficta-canary-from-doppler-fixture-12345";
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_REGISTRY_PROCESS_ENV_ENABLED: process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED,
      FICTA_REGISTRY_PROCESS_ENV_MODE: process.env.FICTA_REGISTRY_PROCESS_ENV_MODE,
      FICTA_REGISTRY_DOPPLER_ENABLED: process.env.FICTA_REGISTRY_DOPPLER_ENABLED,
      FICTA_REGISTRY_DOPPLER_COMMAND: process.env.FICTA_REGISTRY_DOPPLER_COMMAND,
      FICTA_REGISTRY_DOPPLER_CONFIGS: process.env.FICTA_REGISTRY_DOPPLER_CONFIGS,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    const fakeBin = mkdtempSync(join(tmpdir(), "ficta-fake-doppler-"));
    const fakeDoppler = join(fakeBin, "doppler");
    writeFileSync(fakeDoppler, `#!/bin/sh\nprintf '%s\\n' '{"FICTA_CANARY_SECRET":"${canary}"}'\n`, {
      mode: 0o700,
    });
    chmodSync(fakeDoppler, 0o700);

    let received = "";
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received = body;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
      process.env.FICTA_REGISTRY_MIN_LEN = "8";
      process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
      process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "1";
      process.env.FICTA_REGISTRY_DOPPLER_COMMAND = fakeDoppler;
      process.env.FICTA_REGISTRY_DOPPLER_CONFIGS = "current";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `doppler printed ${canary}` }),
      });
      const text = await res.text();
      const surrogate = received.match(/FICTA_[0-9a-f]{32}/)?.[0];

      expect(proxy.protectedValues).toBe(1);
      expect(res.status).toBe(200);
      expect(received).not.toContain(canary);
      expect(surrogate).toBeTruthy();
      expect(text).toContain(canary);
      expect(text).not.toContain(surrogate);
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("redacts and restores known secrets on unknown outbound routes", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let received = "";
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received = body;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
      process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
      process.env.FICTA_REGISTRY_MIN_LEN = "6";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/new-provider/unknown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `unknown path still contains ${AWS}` }),
      });
      const text = await res.text();
      const surrogate = received.match(/FICTA_[0-9a-f]{32}/)?.[0];

      expect(res.status).toBe(200);
      expect(received).not.toContain(AWS);
      expect(surrogate).toBeTruthy();
      expect(text).toContain(AWS);
      expect(text).not.toContain(surrogate);
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("restores surrogates split across Anthropic SSE tool-input events", async () => {
    const secret = "corova-control-plane";
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let received = "";
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received = body;
        const surrogate = body.match(/FICTA_[0-9a-f]{32}/)?.[0] ?? "";
        const first = `{"oldText":"${surrogate.slice(0, 18)}`;
        const second = `${surrogate.slice(18)}","newText":"fixed"}`;
        const sse = [
          anthropicInputDelta(0, first),
          anthropicInputDelta(0, second),
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        ].join("");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({
        port: 0,
        plugins: [
          {
            kind: "registry-source",
            name: "fixture-registry",
            config: { bindings: [], sections: [], envDefaults: {} },
            setup: { registrySources: () => [] },
            discover: () => [],
            loadValues: () => [
              { name: "FIXTURE_SERVICE", value: secret, source: "fixture", kind: "secret", confidence: "exact" },
            ],
          },
        ],
      });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: secret }),
      });
      const text = await res.text();
      const toolInput = [...text.matchAll(/^data: (.+)$/gm)]
        .map((match) => JSON.parse(match[1] ?? "{}"))
        .map((event) => event?.delta?.partial_json ?? "")
        .join("");

      expect(res.status).toBe(200);
      expect(received).not.toContain(secret);
      expect(received).toMatch(/FICTA_[0-9a-f]{32}/);
      expect(toolInput).toContain(`"oldText":"${secret}"`);
      expect(toolInput).not.toContain("FICTA_");
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("restores surrogates in SSE responses that arrive without a content-type (ChatGPT/Codex backend)", async () => {
    const secret = "corova-codex-backend-secret";
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let received = "";
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received = body;
        const surrogate = body.match(/FICTA_[0-9a-f]{32}/)?.[0] ?? "";
        const sse = `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: `BUILD_REF is ${surrogate}.`,
        })}\n\n`;
        // Intentionally no content-type header — mimics the ChatGPT/Codex backend SSE stream.
        res.writeHead(200);
        res.end(sse);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({
        port: 0,
        plugins: [
          {
            kind: "registry-source",
            name: "fixture-registry",
            config: { bindings: [], sections: [], envDefaults: {} },
            setup: { registrySources: () => [] },
            discover: () => [],
            loadValues: () => [
              { name: "FIXTURE_SERVICE", value: secret, source: "fixture", kind: "secret", confidence: "exact" },
            ],
          },
        ],
      });

      // /responses path → openai-responses wire; the missing content-type must not skip restore.
      const res = await fetch(`http://127.0.0.1:${proxy.port}/backend-api/codex/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: secret }),
      });
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(received).not.toContain(secret); // redacted on egress
      expect(received).toMatch(/FICTA_[0-9a-f]{32}/);
      expect(text).toContain(secret); // restored for the client despite no content-type
      expect(text).not.toMatch(/FICTA_[0-9a-f]{32}/); // no placeholder leaked through
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("redacts registered secrets in query strings", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let receivedUrl = "";
    const upstream = createServer((req, res) => {
      receivedUrl = req.url ?? "";
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(receivedUrl);
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
      process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
      process.env.FICTA_REGISTRY_MIN_LEN = "6";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages?token=${AWS}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "no body secret" }),
      });
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(receivedUrl).not.toContain(AWS);
      expect(receivedUrl).toMatch(/token=FICTA_[0-9a-f]{32}/);
      expect(text).toContain(AWS);
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("redacts a registered secret that is percent-encoded in the query string", async () => {
    const secret = "secret value with spaces";
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let receivedUrl = "";
    const upstream = createServer((req, res) => {
      receivedUrl = req.url ?? "";
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({
        port: 0,
        plugins: [
          {
            kind: "registry-source",
            name: "fixture-registry",
            config: { bindings: [], sections: [], envDefaults: {} },
            setup: { registrySources: () => [] },
            discover: () => [],
            loadValues: () => [
              { name: "FIXTURE_SECRET", value: secret, source: "fixture", kind: "secret", confidence: "exact" },
            ],
          },
        ],
      });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages?token=${encodeURIComponent(secret)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "no body secret" }),
      });
      await res.text();

      expect(res.status).toBe(200);
      // The secret survived percent-encoding in the wire query, but must not reach the upstream
      // in any form — decoded or encoded.
      expect(receivedUrl).not.toContain(encodeURIComponent(secret));
      expect(decodeURIComponent(receivedUrl)).not.toContain(secret);
      expect(receivedUrl).toMatch(/token=FICTA_[0-9a-f]{32}/);
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("preserves the wire encoding of query parameters it does not redact", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let receivedUrl = "";
    const upstream = createServer((req, res) => {
      receivedUrl = req.url ?? "";
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
      process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
      process.env.FICTA_REGISTRY_MIN_LEN = "6";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      // `sig` carries an encoding (%20 space, %2B literal plus) that whole-query re-encoding would
      // mangle; only the `token` parameter holding a registered secret should change.
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages?token=${AWS}&sig=a%20b%2Bc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "no body secret" }),
      });
      await res.text();

      expect(res.status).toBe(200);
      expect(receivedUrl).toMatch(/token=FICTA_[0-9a-f]{32}/);
      expect(receivedUrl).not.toContain(AWS);
      expect(receivedUrl).toContain("sig=a%20b%2Bc");
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("redacts registered secrets in non-auth request headers", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let receivedHeader = "";
    const upstream = createServer((req, res) => {
      receivedHeader = String(req.headers["x-secondary-token"] ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(receivedHeader);
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
      process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
      process.env.FICTA_REGISTRY_MIN_LEN = "6";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-secondary-token": `Bearer ${AWS}` },
        body: JSON.stringify({ message: "no body secret" }),
      });
      const text = await res.text();
      const surrogate = receivedHeader.match(/FICTA_[0-9a-f]{32}/)?.[0];

      expect(res.status).toBe(200);
      expect(receivedHeader).not.toContain(AWS);
      expect(surrogate).toBeTruthy();
      expect(text).toContain(AWS);
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("runs detector plugins even when no startup registry values are loaded", async () => {
    const email = "alice@example.com";
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let received = "";
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received = body;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(body);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({
        port: 0,
        plugins: [
          {
            kind: "detector",
            name: "fixture-email-detector",
            detectText: (text: string) =>
              [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])].map((value) => ({
                name: "EMAIL",
                value,
                source: "fixture-detector",
                kind: "pii" as const,
                confidence: "high" as const,
              })),
          },
        ],
      });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `contact ${email}` }),
      });
      const text = await res.text();

      expect(proxy.protectedValues).toBe(0);
      expect(res.status).toBe(200);
      expect(received).not.toContain(email);
      expect(received).toMatch(/FICTA_[0-9a-f]{32}/);
      expect(text).toContain(email);
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("does not restore/decode binary upstream responses", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x42, 0x80]);
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(binary);
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
      process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
      process.env.FICTA_REGISTRY_MIN_LEN = "6";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "no body secret" }),
      });
      const bytes = Buffer.from(await res.arrayBuffer());

      expect(res.status).toBe(200);
      expect(bytes.equals(binary)).toBe(true);
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("serves health locally without forwarding upstream", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_LOG_LEVEL: process.env.FICTA_LOG_LEVEL,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
    };

    let upstreamHits = 0;
    const upstream = createServer((_req, res) => {
      upstreamHits++;
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("should not be hit");
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
      process.env.FICTA_REGISTRY_ENV_FILE_PATHS = "test/fixtures/secrets.env";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/__ficta/health`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true, service: "ficta" });
      expect(upstreamHits).toBe(0);
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("pii fail-closed backend", () => {
  const PII_ENV = [
    "FICTA_UPSTREAM",
    "FICTA_REGISTRY_ENV_FILE_ENABLED",
    "FICTA_REGISTRY_PROCESS_ENV_ENABLED",
    "FICTA_REGISTRY_DOPPLER_ENABLED",
    "FICTA_LOG_LEVEL",
    "FICTA_LOG_DIR",
    "FICTA_SURROGATE_KEY",
    "FICTA_PII_ENABLED",
    "FICTA_PII_BACKEND",
    "FICTA_PII_FAIL_CLOSED",
    "FICTA_FAIL_CLOSED_DETECTION",
    "FICTA_PII_PRESIDIO_URL",
    "FICTA_PII_PRESIDIO_TIMEOUT_MS",
  ] as const;

  it("reports Presidio outage and fail-open/closed posture via status", async () => {
    const original = Object.fromEntries(PII_ENV.map((k) => [k, process.env[k]]));
    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      // A bound-then-released port refuses connections → presidio backend is "down".
      const dead = createServer();
      const deadPort = await listen(dead);
      await close(dead);

      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
      process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
      process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-status-"));
      process.env.FICTA_PII_ENABLED = "1";
      process.env.FICTA_PII_BACKEND = "presidio";
      process.env.FICTA_PII_FAIL_CLOSED = "0";
      process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${deadPort}`;
      process.env.FICTA_PII_PRESIDIO_TIMEOUT_MS = "300";

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const failOpen = await fetch(`http://127.0.0.1:${proxy.port}/__ficta/status`);
      const openBody = await failOpen.json();
      expect(failOpen.status).toBe(200);
      expect(openBody).toMatchObject({
        ok: true,
        service: "ficta",
        protection: { protecting: true },
        pii: { enabled: true, backend: "presidio", status: "degraded", failureMode: "fail-open" },
      });
      expect(openBody.pii.message).toContain("fail-open");

      process.env.FICTA_PII_FAIL_CLOSED = "1";
      const failClosed = await fetch(`http://127.0.0.1:${proxy.port}/__ficta/status`);
      const closedBody = await failClosed.json();
      expect(closedBody).toMatchObject({
        pii: { enabled: true, backend: "presidio", status: "blocking", failureMode: "fail-closed" },
      });
      expect(closedBody.pii.message).toContain("fail-closed");
    } finally {
      proxy?.close();
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("blocks with 503 when presidio is down and fail_closed is set, forwards when fail-open", async () => {
    const original = Object.fromEntries(PII_ENV.map((k) => [k, process.env[k]]));
    let upstreamHits = 0;
    const upstream = createServer((req, res) => {
      upstreamHits++;
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });

    let proxy: Awaited<ReturnType<typeof import("../src/server.js")["startProxy"]>> | undefined;
    try {
      const upstreamPort = await listen(upstream);
      // A bound-then-released port refuses connections → presidio backend is "down".
      const dead = createServer();
      const deadPort = await listen(dead);
      await close(dead);

      process.env.FICTA_UPSTREAM = `http://127.0.0.1:${upstreamPort}`;
      process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "0";
      process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
      process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
      process.env.FICTA_LOG_LEVEL = "silent";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-pii-failclosed-"));
      process.env.FICTA_SURROGATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      process.env.FICTA_PII_ENABLED = "1";
      process.env.FICTA_PII_BACKEND = "presidio";
      process.env.FICTA_PII_FAIL_CLOSED = "1";
      process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${deadPort}`;
      process.env.FICTA_PII_PRESIDIO_TIMEOUT_MS = "300";

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({ port: 0 });

      const send = () =>
        fetch(`http://127.0.0.1:${proxy?.port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "Reply to Jane Doe" }] }),
        });

      // fail-closed: the gateway can't screen the body, so it refuses to forward.
      const blocked = await send();
      expect(blocked.status).toBe(503);
      expect((await blocked.json()).error.type).toBe("ficta_blocked");
      expect(upstreamHits).toBe(0);

      // flip to fail-open (default): the same down backend now skips detection and forwards.
      process.env.FICTA_PII_FAIL_CLOSED = "0";
      const forwarded = await send();
      expect(forwarded.status).toBe(200);
      await forwarded.text();
      expect(upstreamHits).toBe(1);

      // global default alone (no per-plugin override) also blocks — core-enforced.
      delete process.env.FICTA_PII_FAIL_CLOSED;
      process.env.FICTA_FAIL_CLOSED_DETECTION = "1";
      const globalBlocked = await send();
      expect(globalBlocked.status).toBe(503);
      expect(upstreamHits).toBe(1); // unchanged — not forwarded
    } finally {
      proxy?.close();
      await close(upstream);
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
