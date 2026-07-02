# ficta — performance benchmarks

*Recorded 2026-06-21 on darwin (Apple Silicon), Node v24.17.0. Reproduce:*
```sh
pnpm exec tsx bench/redaction-bench.mts   # core ops, isolated from network
pnpm exec tsx bench/e2e-bench.mts          # round-trip latency vs direct
```

Two layers: a **microbench** of the vault's core operations (no network, isolates CPU cost) and
an **end-to-end** measurement of proxy round-trip latency against a local mock upstream
(`FICTA_LOG_LEVEL=silent`, so disk/console I/O doesn't skew it).

## 1. Vault microbench (per-operation, milliseconds)

Permutations: registry size {10, 100, 1000 known secrets} × body size {1KB, 50KB, 500KB}. Body
embeds 5 secrets in a `tool_result`; the rest is filler.

| registry | body  | redactBody p50/mean/p95 | leakCount (gate) p50 | restoreText p50 | restoreStream p50 |
|---------:|------:|-------------------------|---------------------:|----------------:|------------------:|
|       10 |   1KB | 0.006 / 0.007 / 0.011   | 0.003 | 0.001 | 0.020 |
|       10 |  50KB | 0.063 / 0.065 / 0.096   | 0.036 | 0.004 | 0.091 |
|       10 | 500KB | 0.760 / 0.852 / 2.225   | 0.367 | 0.059 | 0.839 |
|      100 |   1KB | 0.009 / 0.010 / 0.012   | 0.008 | 0.001 | 0.017 |
|      100 |  50KB | 0.131 / 0.141 / 0.185   | 0.111 | 0.005 | 0.086 |
|      100 | 500KB | 1.546 / 1.567 / 1.840   | 1.187 | 0.065 | 0.716 |
|     1000 |   1KB | 0.036 / 0.035 / 0.037   | 0.035 | 0.001 | 0.011 |
|     1000 |  50KB | 0.874 / 0.883 / 0.925   | 0.876 | 0.005 | 0.080 |
|     1000 | 500KB | 9.429 / 9.474 / 9.812   | 9.032 | 0.067 | 0.704 |

**Reading it:**
- **Redaction cost is `O(registry × body)`** — it substring-scans each known value against each
  string leaf. Typical (100 secrets, 50KB) ≈ **0.13 ms**; pathological (1000 secrets, 500KB) ≈
  **9.4 ms**.
- **The fail-closed gate (`leakCount`) costs about the same as redaction** — it's a second full
  scan. Budget redact+gate together (~2× the redact number).
- **Restore is cheap and registry-independent.** `restoreText` is a single regex pass
  (~0.06 ms even at 500KB); streamed restore is body-size-bound (~0.7 ms at 500KB), not affected
  by how many secrets you have.

## 2. End-to-end round-trip latency (localhost, ms)

Request ~50KB (embeds 5 secrets), response ~50KB, 120 iters, mock upstream on localhost.

| response | path               | p50 | mean | p95 | overhead vs direct (p50) |
|----------|--------------------|----:|-----:|----:|--------------------------|
| json     | direct (no ficta)  | 1.563 | 1.508 | 1.656 | — |
| json     | ficta passthrough  | 3.560 | 3.546 | 3.874 | **+2.00 ms** |
| json     | ficta redacting    | 4.339 | 4.262 | 4.970 | **+2.78 ms** |
| sse      | direct (no ficta)  | 1.577 | 1.505 | 1.706 | — |
| sse      | ficta passthrough  | 3.454 | 3.510 | 4.262 | **+1.88 ms** |
| sse      | ficta redacting    | 4.500 | 4.520 | 5.331 | **+2.92 ms** |

**Reading it:**
- **Proxy plumbing** (Hono + `fetch` + stream tee on localhost) adds **~2 ms**.
- **Redaction on top** adds **~0.8–1 ms** for a 50KB body × 100 secrets (redact + gate + restore
  stream), consistent with the microbench.
- Streaming (SSE) behaves like JSON here because the mock returns instantly; against a real model
  the response arrives over seconds, so the streaming-restore cost is amortized to ~0.

## Bottom line

- Total ficta overhead is **~2–3 ms/request** at typical sizes. Against real providers (round
  trips of **hundreds of ms to seconds**), that's **well under 1%** — effectively free.
- The only thing that grows cost is **registry size × body size** (the redact + gate scans).
  Keep the registry to your actual secrets (tens–hundreds), not thousands, and overhead stays
  sub-millisecond. A 1000-secret registry on 500KB bodies is the worst case measured (~18 ms
  redact+gate) and is still negligible next to model latency.
- **Restore never scales with registry size** — cheap enough to leave on always.

### If overhead ever matters (it won't, but)
- Build an Aho-Corasick / single-pass multi-string matcher to make redact+gate `O(body)` instead
  of `O(registry × body)`.
- Skip the gate's re-parse by checking during the redact walk.

Neither is worth doing now.
