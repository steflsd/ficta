// Microbenchmark of the vault's core ops, isolated from network/model latency.
// Run: pnpm exec tsx bench/redaction-bench.mts
import { Vault } from "../src/vault.js";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function randStr(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return s;
}
function genSecrets(n: number): { value: string }[] {
  const out: { value: string }[] = [];
  for (let i = 0; i < n; i++) out.push({ value: "sk-" + randStr(28) });
  return out;
}

function buildBody(targetBytes: number, secrets: { value: string }[]): string {
  const embedded = secrets
    .slice(0, 5)
    .map((s, i) => `KEY${i}=${s.value}`)
    .join("\n");
  const fillerLen = Math.max(0, targetBytes - embedded.length - 160);
  const content = embedded + "\n" + "x".repeat(fillerLen);
  return JSON.stringify({
    model: "m",
    stream: true,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content }] }],
  });
}

function stats(times: number[]) {
  const s = [...times].sort((a, b) => a - b);
  if (s.length === 0) return { mean: 0, p50: 0, p95: 0 };
  const sum = s.reduce((a, b) => a + b, 0);
  return { mean: sum / s.length, p50: s[Math.floor(s.length * 0.5)] ?? 0, p95: s[Math.floor(s.length * 0.95)] ?? 0 };
}
function timeSync(fn: () => void, iters: number, warmup = 5): number[] {
  for (let i = 0; i < warmup; i++) fn();
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return ts;
}
async function timeAsync(fn: () => Promise<void>, iters: number, warmup = 3): Promise<number[]> {
  for (let i = 0; i < warmup; i++) await fn();
  const ts: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await fn();
    ts.push(performance.now() - t0);
  }
  return ts;
}

async function streamRestore(v: Vault, body: string): Promise<void> {
  const rs = v.restoreStream();
  const w = rs.writable.getWriter();
  const r = rs.readable.getReader();
  const enc = new TextEncoder();
  const CHUNK = 16384;
  const pump = (async () => {
    for (;;) {
      const { done } = await r.read();
      if (done) break;
    }
  })();
  for (let i = 0; i < body.length; i += CHUNK) await w.write(enc.encode(body.slice(i, i + CHUNK)));
  await w.close();
  await pump;
}

const REG_SIZES = [10, 100, 1000];
const BODY_SIZES: [string, number, number][] = [
  ["1KB", 1024, 200],
  ["50KB", 50 * 1024, 60],
  ["500KB", 500 * 1024, 20],
];

const fmt = (n: number) => n.toFixed(3).padStart(8);
console.log(`\nficta vault microbench — ${process.platform} node ${process.version}\n`);
console.log(
  "| registry | body  | iters | redactBody (ms) p50/mean/p95 | leakCount p50 | restoreText p50 | restoreStream p50 |",
);
console.log(
  "|---------:|------:|------:|------------------------------|--------------:|----------------:|------------------:|",
);

for (const reg of REG_SIZES) {
  const secrets = genSecrets(reg);
  const vault = new Vault(secrets);
  for (const [label, bytes, iters] of BODY_SIZES) {
    const body = buildBody(bytes, secrets);
    const redacted = vault.redactBody(body).body;

    const rb = stats(timeSync(() => void vault.redactBody(body), iters));
    const lc = stats(timeSync(() => void vault.leakCount(redacted), iters));
    const rt = stats(timeSync(() => void vault.restoreText(redacted), iters));
    const ss = stats(await timeAsync(() => streamRestore(vault, redacted), Math.max(10, Math.floor(iters / 3))));

    console.log(
      `| ${String(reg).padStart(8)} | ${label.padStart(5)} | ${String(iters).padStart(5)} | ` +
        `${fmt(rb.p50)}/${fmt(rb.mean)}/${fmt(rb.p95)} | ${fmt(lc.p50)} | ${fmt(rt.p50)} | ${fmt(ss.p50)} |`,
    );
  }
}
console.log(
  "\n(redactBody = parse+walk+replace; leakCount = fail-closed gate; restoreText = response replace; restoreStream = chunked SSE restore)\n",
);
