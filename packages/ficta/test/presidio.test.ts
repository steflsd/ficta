import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProtectedValue } from "../src/plugins/index.js";
import {
  checkPresidioHealth,
  PresidioUnavailableError,
  presidioRecognizer,
} from "../src/plugins/pii/presidio-recognizer.js";

interface AnalyzeRequest {
  text: string;
  language: string;
  score_threshold?: number;
  entities?: string[];
}

interface StubOptions {
  /** Map an /analyze request to the span array it should return. */
  analyze?: (req: AnalyzeRequest) => unknown;
  /** Force a non-2xx status on /analyze. */
  status?: number;
  /** Return this exact (possibly non-JSON) body on /analyze. */
  raw?: string;
  /** Never respond to /analyze (to exercise the client timeout). */
  hang?: boolean;
  /** Status for GET /health (default 200). */
  health?: number;
}

const BODY = { surface: "body" } as const;

const ENV_KEYS = [
  "FICTA_PII_ENABLED",
  "FICTA_PII_BACKEND",
  "FICTA_PII_PRESIDIO_URL",
  "FICTA_PII_PRESIDIO_LANGUAGE",
  "FICTA_PII_PRESIDIO_SCORE_THRESHOLD",
  "FICTA_PII_PRESIDIO_ENTITIES",
  "FICTA_PII_PRESIDIO_TIMEOUT_MS",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("presidio recognizer", () => {
  it("maps analyzer spans to ProtectedValues with category, source, and confidence tiers", async () => {
    const text = "My name is John Smith, phone 212-555-0187";
    const { result } = await withStub(
      { analyze: () => [span(text, "John Smith", "PERSON", 0.9), span(text, "212-555-0187", "PHONE_NUMBER", 0.6)] },
      () => presidioRecognizer.detect(text, BODY),
    );

    const byName = Object.fromEntries(result.map((v) => [v.name, v]));
    expect(byName.person).toMatchObject({
      value: "John Smith",
      source: "pii-presidio",
      kind: "pii",
      confidence: "high",
    });
    expect(byName["phone-number"]).toMatchObject({ value: "212-555-0187", confidence: "probabilistic" });
  });

  it("sends {text, language, score_threshold} and omits entities unless configured", async () => {
    const text = "contact John Smith";
    const { requests } = await withStub({ analyze: () => [] }, () => presidioRecognizer.detect(text, BODY));
    expect(requests[0]).toMatchObject({ text, language: "en", score_threshold: 0.5 });
    expect(requests[0]).not.toHaveProperty("entities");

    process.env.FICTA_PII_PRESIDIO_ENTITIES = "PERSON, PHONE_NUMBER";
    const withEntities = await withStub({ analyze: () => [] }, () => presidioRecognizer.detect(text, BODY));
    expect(withEntities.requests[0]?.entities).toEqual(["PERSON", "PHONE_NUMBER"]);
  });

  it("drops below-threshold spans, short values, and duplicate values", async () => {
    const text = "John Smith met Al and John Smith again";
    const { result } = await withStub(
      {
        analyze: () => [
          span(text, "John Smith", "PERSON", 0.9), // kept
          span(text, "John Smith", "PERSON", 0.9), // exact-value dupe → collapsed
          { entity_type: "PERSON", start: text.indexOf("Al"), end: text.indexOf("Al") + 2, score: 0.9 }, // "Al" too short
          span(text, "John Smith", "PERSON", 0.2), // below default 0.5 threshold (also a dupe)
        ],
      },
      () => presidioRecognizer.detect(text, BODY),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe("John Smith");
  });

  it("respects a configured entity allowlist client-side", async () => {
    process.env.FICTA_PII_PRESIDIO_ENTITIES = "PERSON";
    const text = "John Smith lives in Springfield today";
    const { result } = await withStub(
      { analyze: () => [span(text, "John Smith", "PERSON", 0.9), span(text, "Springfield", "LOCATION", 0.9)] },
      () => presidioRecognizer.detect(text, BODY),
    );
    expect(result.map((v) => v.value)).toEqual(["John Smith"]);
  });

  it("slices the correct value when astral characters precede the span (code-point offsets)", async () => {
    const text = "🎉 contact John Smith now";
    const person = "John Smith";
    const cpStart = Array.from(text.slice(0, text.indexOf(person))).length; // Python code-point offset
    const cpEnd = cpStart + Array.from(person).length;
    const { result } = await withStub(
      { analyze: () => [{ entity_type: "PERSON", start: cpStart, end: cpEnd, score: 0.9 }] },
      () => presidioRecognizer.detect(text, BODY),
    );
    expect(result[0]?.value).toBe("John Smith");
  });

  it("does not contact the sidecar for non-body surfaces", async () => {
    const { result, requests } = await withStub({ analyze: () => [span("x", "x", "PERSON", 0.9)] }, () =>
      presidioRecognizer.detect("email FICTA test", { surface: "header", header: "x-test" }),
    );
    expect(result).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("issues one /analyze call per chunk for oversized bodies and maps later-chunk values", async () => {
    const filler = "a\n".repeat(15_000); // ~30k chars → splits on newlines into >1 chunk
    const text = `${filler}find SECRETNAME here`;
    const { result, requests } = await withStub(
      {
        analyze: (req) => {
          const idx = req.text.indexOf("SECRETNAME");
          return idx < 0 ? [] : [{ entity_type: "PERSON", start: idx, end: idx + "SECRETNAME".length, score: 0.9 }];
        },
      },
      () => presidioRecognizer.detect(text, BODY),
    );
    expect(requests.length).toBeGreaterThan(1);
    expect(result.map((v) => v.value)).toContain("SECRETNAME");
  });

  describe("failure taxonomy (fail-open is the plugin's job; the recognizer throws)", () => {
    it("throws unreachable when nothing is listening", async () => {
      const port = await closedPort();
      process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
      await expect(presidioRecognizer.detect("John Smith here", BODY)).rejects.toMatchObject({
        reason: "unreachable",
      });
    });

    it("throws http_error on a non-2xx response", async () => {
      await expect(
        withStub({ status: 500 }, () => presidioRecognizer.detect("John Smith here", BODY)),
      ).rejects.toMatchObject({ reason: "http_error", detail: "500" });
    });

    it("throws bad_response on non-JSON", async () => {
      await expect(
        withStub({ raw: "not json" }, () => presidioRecognizer.detect("John Smith here", BODY)),
      ).rejects.toMatchObject({ reason: "bad_response" });
    });

    it("throws timeout within the configured budget when the sidecar hangs", async () => {
      process.env.FICTA_PII_PRESIDIO_TIMEOUT_MS = "100";
      const started = performance.now();
      await expect(
        withStub({ hang: true }, () => presidioRecognizer.detect("John Smith here", BODY)),
      ).rejects.toBeInstanceOf(PresidioUnavailableError);
      expect(performance.now() - started).toBeLessThan(1500);
    });
  });

  describe("checkPresidioHealth", () => {
    it("reports ok when /health returns 200", async () => {
      const { server, port } = await start({ analyze: () => [] });
      process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
      try {
        expect(await checkPresidioHealth()).toMatchObject({ ok: true });
      } finally {
        await close(server);
      }
    });

    it("reports not-ok (never throws) when the sidecar is down", async () => {
      const port = await closedPort();
      process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
      const health = await checkPresidioHealth();
      expect(health.ok).toBe(false);
      expect(health.detail).toBeTruthy();
    });
  });
});

// --- helpers ---------------------------------------------------------------

/** A span for `value`'s first occurrence in `text` (no astral chars → code-point offset === index). */
function span(text: string, value: string, entityType: string, score: number) {
  const start = text.indexOf(value);
  return { entity_type: entityType, start, end: start + value.length, score };
}

function makeStub(opts: StubOptions): { server: Server; requests: AnalyzeRequest[] } {
  const requests: AnalyzeRequest[] = [];
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.statusCode = opts.health ?? 200;
      res.end("ok");
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (opts.hang) return; // never respond
      requests.push(JSON.parse(body) as AnalyzeRequest);
      if (opts.status && opts.status >= 400) {
        res.statusCode = opts.status;
        res.end("error");
        return;
      }
      res.setHeader("content-type", "application/json");
      if (opts.raw !== undefined) {
        res.end(opts.raw);
        return;
      }
      const spans = opts.analyze ? opts.analyze(JSON.parse(body) as AnalyzeRequest) : [];
      res.end(JSON.stringify(spans));
    });
  });
  return { server, requests };
}

async function start(opts: StubOptions): Promise<{ server: Server; port: number; requests: AnalyzeRequest[] }> {
  const { server, requests } = makeStub(opts);
  const port = await listen(server);
  return { server, port, requests };
}

/** Run `fn` against a fresh stub, pointing the recognizer at it, and always tear the stub down. */
async function withStub<T>(
  opts: StubOptions,
  fn: () => Promise<T>,
): Promise<{ result: ProtectedValue[]; requests: AnalyzeRequest[]; value: T }> {
  const { server, port, requests } = await start(opts);
  process.env.FICTA_PII_PRESIDIO_URL = `http://127.0.0.1:${port}`;
  try {
    const value = await fn();
    return { result: value as ProtectedValue[], requests, value };
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections?.(); // release any hung sockets from the timeout test
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Bind then release a port so a subsequent connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
