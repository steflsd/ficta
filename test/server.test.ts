import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

describe("proxy hardening", () => {
  it("does not write protected literals into safe metadata logs", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_PROCESS_ENV_ENABLED: process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_LOG_BODIES: process.env.FICTA_LOG_BODIES,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
      FICTA_SILENT: process.env.FICTA_SILENT,
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
      process.env.FICTA_LOG_BODIES = "0";
      process.env.FICTA_LOG_DIR = logDir;
      process.env.FICTA_SILENT = "1";

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
      FICTA_LOG_BODIES: process.env.FICTA_LOG_BODIES,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
      FICTA_SILENT: process.env.FICTA_SILENT,
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
      process.env.FICTA_LOG_BODIES = "0";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));
      process.env.FICTA_SILENT = "1";

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
      FICTA_LOG_BODIES: process.env.FICTA_LOG_BODIES,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
      FICTA_SILENT: process.env.FICTA_SILENT,
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
      process.env.FICTA_LOG_BODIES = "0";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));
      process.env.FICTA_SILENT = "1";

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

  it("redacts registered secrets in query strings", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_LOG_BODIES: process.env.FICTA_LOG_BODIES,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
      FICTA_SILENT: process.env.FICTA_SILENT,
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
      process.env.FICTA_LOG_BODIES = "0";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));
      process.env.FICTA_SILENT = "1";

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

  it("redacts registered secrets in non-auth request headers", async () => {
    const originalEnv = {
      FICTA_UPSTREAM: process.env.FICTA_UPSTREAM,
      FICTA_REGISTRY_ENV_FILE_ENABLED: process.env.FICTA_REGISTRY_ENV_FILE_ENABLED,
      FICTA_REGISTRY_ENV_FILE_PATHS: process.env.FICTA_REGISTRY_ENV_FILE_PATHS,
      FICTA_REGISTRY_MIN_LEN: process.env.FICTA_REGISTRY_MIN_LEN,
      FICTA_LOG_BODIES: process.env.FICTA_LOG_BODIES,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
      FICTA_SILENT: process.env.FICTA_SILENT,
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
      process.env.FICTA_LOG_BODIES = "0";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));
      process.env.FICTA_SILENT = "1";

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
      FICTA_LOG_BODIES: process.env.FICTA_LOG_BODIES,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
      FICTA_SILENT: process.env.FICTA_SILENT,
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
      process.env.FICTA_LOG_BODIES = "0";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));
      process.env.FICTA_SILENT = "1";

      const { startProxy } = await import("../src/server.js");
      proxy = await startProxy({
        port: 0,
        plugins: [
          {
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
      FICTA_LOG_BODIES: process.env.FICTA_LOG_BODIES,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
      FICTA_SILENT: process.env.FICTA_SILENT,
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
      process.env.FICTA_LOG_BODIES = "0";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));
      process.env.FICTA_SILENT = "1";

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
      FICTA_LOG_BODIES: process.env.FICTA_LOG_BODIES,
      FICTA_LOG_DIR: process.env.FICTA_LOG_DIR,
      FICTA_SILENT: process.env.FICTA_SILENT,
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
      process.env.FICTA_LOG_BODIES = "0";
      process.env.FICTA_LOG_DIR = mkdtempSync(join(tmpdir(), "ficta-test-"));
      process.env.FICTA_SILENT = "1";

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
