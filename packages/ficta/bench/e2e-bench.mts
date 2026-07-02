// End-to-end proxy latency: direct-to-mock vs through ficta (passthrough vs redacting).
// Run: pnpm exec tsx bench/e2e-bench.mts
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const randStr = (n: number) =>
  Array.from({ length: n }, () => ALNUM[Math.floor(Math.random() * ALNUM.length)]).join("");

const MOCK = 9970;
const PASS = 9971; // ficta passthrough (no registry)
const REDACT = 9972; // ficta redacting (100 secrets)

// ---- registry + request body (embeds 5 known secrets, ~50KB) ----
const secrets = Array.from({ length: 100 }, () => "sk-" + randStr(28));
writeFileSync("/tmp/ficta_bench.env", secrets.map((v, i) => `K${i}=${v}`).join("\n"));
const embedded = secrets
  .slice(0, 5)
  .map((v, i) => `KEY${i}=${v}`)
  .join("\n");
const reqBody = JSON.stringify({
  model: "m",
  messages: [
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: embedded + "\n" + "x".repeat(50 * 1024) }],
    },
  ],
});

// ---- mock upstream: ~50KB JSON or SSE depending on x-bench-mode ----
const bigText = "y".repeat(50 * 1024);
const jsonResp = JSON.stringify({ content: [{ type: "text", text: bigText }] });
const sseResp =
  Array.from(
    { length: 50 },
    (_, i) =>
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "y".repeat(1024) + i } })}\n`,
  ).join("\n") + "\n";
const mock = createServer((req, res) => {
  if (req.headers["x-bench-mode"] === "sse") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseResp);
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(jsonResp);
  }
});
await new Promise<void>((r) => mock.listen(MOCK, r));

function startFicta(port: number, envFile: string): ChildProcess {
  return spawn("./node_modules/.bin/tsx", ["src/server.ts"], {
    env: {
      ...process.env,
      FICTA_CONFIG_FILE: "0",
      FICTA_PORT: String(port),
      FICTA_UPSTREAM: `http://localhost:${MOCK}`,
      FICTA_REGISTRY_DOPPLER_ENABLED: "0",
      FICTA_REGISTRY_ENV_FILE_ENABLED: envFile === "0" ? "0" : "1",
      FICTA_REGISTRY_ENV_FILE_PATHS: envFile,
      FICTA_LOG_LEVEL: "silent",
      FICTA_LOG_DIR: "/tmp/ficta_bench_logs",
    },
    stdio: "ignore",
  });
}
async function waitReady(port: number) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`http://localhost:${port}/ready`);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`ficta ${port} not ready`);
}

function stats(t: number[]) {
  const s = [...t].sort((a, b) => a - b);
  if (s.length === 0) return { mean: 0, p50: 0, p95: 0 };
  const sum = s.reduce((a, b) => a + b, 0);
  return { mean: sum / s.length, p50: s[Math.floor(s.length * 0.5)] ?? 0, p95: s[Math.floor(s.length * 0.95)] ?? 0 };
}
async function bench(url: string, mode: "json" | "sse", iters: number, warmup = 15) {
  const once = async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bench-mode": mode },
      body: reqBody,
    });
    await res.text();
  };
  for (let i = 0; i < warmup; i++) await once();
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await once();
    ts.push(performance.now() - t0);
  }
  return stats(ts);
}

const pass = startFicta(PASS, "0"); // env-file registry disabled → pure passthrough
const redact = startFicta(REDACT, "/tmp/ficta_bench.env");
await waitReady(PASS);
await waitReady(REDACT);

const ITERS = 120;
const fmt = (n: number) => n.toFixed(3).padStart(7);
console.log(
  `\nficta e2e latency — ${process.platform} node ${process.version} — req ~50KB, resp ~50KB, ${ITERS} iters\n`,
);
console.log("| response | path                | p50 ms | mean ms | p95 ms | overhead vs direct (p50) |");
console.log("|----------|---------------------|-------:|--------:|-------:|--------------------------|");

for (const mode of ["json", "sse"] as const) {
  const direct = await bench(`http://localhost:${MOCK}/v1/messages`, mode, ITERS);
  const p = await bench(`http://localhost:${PASS}/v1/messages`, mode, ITERS);
  const r = await bench(`http://localhost:${REDACT}/v1/messages`, mode, ITERS);
  const row = (name: string, s: ReturnType<typeof stats>, base: number) =>
    `| ${mode.padEnd(8)} | ${name.padEnd(19)} | ${fmt(s.p50)} | ${fmt(s.mean)} | ${fmt(s.p95)} | ${name === "direct (no ficta)" ? "—" : "+" + (s.p50 - base).toFixed(3) + " ms"} |`;
  console.log(row("direct (no ficta)", direct, direct.p50));
  console.log(row("ficta passthrough", p, direct.p50));
  console.log(row("ficta redacting", r, direct.p50));
}

pass.kill();
redact.kill();
mock.close();
console.log("\n(passthrough = proxy plumbing only; redacting = + redact request + gate + restore stream)\n");
process.exit(0);
