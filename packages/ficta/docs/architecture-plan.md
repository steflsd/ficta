# ficta — reversible anonymizing proxy (provider-agnostic)

> **Product definition and shipped scoped guarantee live in [`README.md`](../README.md),
> [`threat-model.md`](./threat-model.md), and [`decisions.md`](./decisions.md).** This
> file is retained as historical architecture notes and includes aspirational phase-2 ideas; do not
> treat detector/PII/placeholders details below as shipped behavior or public positioning.

## Context

`ficta` is a small, independent **intercepting proxy** that sits between AI coding
clients (Claude Code, Codex, Pi, …) and model upstreams. Its shipped guarantee is scoped to
registered values in covered request surfaces; see [`README.md`](../README.md) and [`decisions.md`](./decisions.md) for the
current security boundary and path-redaction caveat. It replaces protected spans with stable
placeholders on the request, keeps a return map (vault), and restores the real values in the
response — text and tool-call args, including streaming — so the agent still edits real files and
sees real data.

This is fully standalone. It does **not** depend on headroom; headroom (or any other
proxy) is merely *one optional upstream* you can forward to. The default upstream is the
real provider.

### How the intercept works (the generic hook)
Every one of these clients lets you override its API base URL via env var. Point it at
ficta; ficta forwards to the real upstream:
- **Claude Code:** `ANTHROPIC_BASE_URL` → Anthropic *Messages* API (`/v1/messages`).
- **Codex / OpenAI clients:** `OPENAI_BASE_URL` / `OPENAI_API_BASE` → OpenAI *Chat
  Completions* (`/v1/chat/completions`) or *Responses* API (`/v1/responses`; Codex uses
  Responses).
- **Anything else:** same pattern — override its base URL.

The proxy is otherwise transparent: forward all headers (incl. auth) untouched, only
rewrite the JSON body on the way out and the body/stream on the way back.

### Decisions
- **Reversible** round-trip tokenization (not one-way redaction).
- **Fully standalone & provider-agnostic.** Works for Claude / Codex / Pi / any
  base-URL-overridable client. Upstream is configurable (real provider by default;
  optionally headroom or any other proxy).
- **Language: TypeScript, pnpm + Node.** I/O-bound streaming proxy + regex/string
  substitution; SSE rewriting and the split-token restorer map cleanly onto Web Streams
  `TransformStream`.
- **Historical MVP idea:** regex detectors (secrets + structured PII) + full reversible streaming
  round-trip, across the Anthropic + OpenAI wire formats. Current public positioning is
  secrets-first exact-match registry coverage; PII/NER remains optional best-effort detector work,
  not a headline promise.

## Architecture

```
 any client ──HTTP──►  ficta (Node)  ──► real upstream (provider │ headroom │ …)
 (BASE_URL=ficta)        │ request: detect + replace → «HR:…» placeholders, build vault
                         │ vault: placeholder ⇄ real value  (per request)
   real values ◄─────────┘ response: restore «HR:…» in text + tool-call args (incl. SSE)
```

### Core (provider-agnostic, security-critical, heavily tested)
Operates purely on **strings** — independent of wire format:
- `core/detectors.ts` — regex detectors → spans `{start,end,type,value}`.
  - Secrets: AWS (`AKIA…`), `sk-…`/OpenAI-style keys, GitHub (`ghp_…`), JWTs, PEM private
    keys, DB connection strings, generic high-entropy tokens.
  - Optional/best-effort structured PII examples: email, phone, IPv4/IPv6, credit card (Luhn), SSN.
- `core/vault.ts` — `Vault`: `placeholderFor(value,type)` deterministic via keyed local token
  (same value → same opaque placeholder within a proxy run; a local key can make it stable
  across restarts), memoized; `restore(text)` literal multi-replace, **tolerant** of unknown/garbled
  placeholders (never errors a response).
- `core/stream-restorer.ts` — `StreamRestorer`: holdback buffer that emits up to the last
  `«HR:` sentinel lacking a closing `»`, holds the tail (bounded by max placeholder length)
  until the token completes or is disproven, `flush()` emits the rest. Guarantees the client
  never sees a partial placeholder split across stream chunks (`«HR:EMA`…`IL:a1b2»`).

### Provider adapters (the only wire-format-specific code)
A small `ProviderAdapter` interface isolates "where are the strings in this format":
- `match(path, body)` — does this request belong to this adapter?
- `anonymizeRequest(body, vault)` — walk this format's message/content shape, replace spans.
  - Anthropic: `system` + `messages[].content` (string & block forms) + `tool_result`.
  - OpenAI chat: `messages[].content` (+ array parts) + tool/function args.
  - OpenAI Responses: `input[]` items + tool call args.
- `restoreResponse(json, restore)` — non-streaming: text fields + tool-call argument JSON.
- `streamTransform(restorerFactory)` — a `TransformStream` over this format's SSE:
  - Anthropic: rewrite `content_block_delta` `text_delta.text` / `input_json_delta.partial_json`;
    flush per block on `content_block_stop`.
  - OpenAI: rewrite `choices[].delta.content` / `tool_calls[].function.arguments` (chat),
    or `response.output_text.delta` / function-arg deltas (Responses).

MVP ships **Anthropic + OpenAI(chat+responses)** adapters; the interface makes adding more
(Gemini, etc.) additive.

### Proxy shell
- `server.ts` — Node `http` server (or Hono). Routes by path → adapter; forwards to the
  configured upstream for that provider via `undici`/native `fetch`; carries the per-request
  `Vault` in the handler closure. Streaming vs non-streaming chosen from the request/response.
- **Config (env):** `FICTA_PORT`; per-provider upstream (`FICTA_ANTHROPIC_UPSTREAM` default
  `https://api.anthropic.com`, `FICTA_OPENAI_UPSTREAM` default `https://api.openai.com`, each
  overridable to point at headroom or anything); per-category detector toggles;
  `FICTA_FAIL_CLOSED`.

### Failure mode (scoped protection choice)
This is a model-traffic privacy boundary, so **default fail-closed**: if request-side detection
throws, return an error rather than forward raw text upstream in the covered channel.
`FICTA_FAIL_CLOSED=0` fails open for debugging. Response-side restore failures never block (the
placeholder is already safe for the provider channel).

## Scoped guarantee & threat model

**Goal:** a protected registered value the agent puts in a covered request surface (e.g. a Doppler
key the model read from a file) should not be forwarded upstream in the clear; if it would be, the
request is blocked. See [`threat-model.md`](./threat-model.md) and [`decisions.md`](./decisions.md) for shipped caveats such as path
preservation.

### What reaches upstream
- **Provider auth header** (your Anthropic/OpenAI key) passes through untouched — required
  to authenticate. ficta only rewrites the request **body**.
- **Body secrets** (Doppler `dp.pt.`/`dp.st.`/…, AWS `AKIA…`, GitHub `ghp_…`, JWTs, PEM,
  etc.) are replaced before forwarding.

### Outbound fail-closed gate (the hard invariant)
After anonymizing and **before** forwarding, re-scan the exact outbound bytes with a *more
paranoid* detector (prefix patterns + high-entropy heuristic + registered known values). If
anything still matches, **refuse to forward** (error to client). Invariant:

> *No registered value in a covered request surface should be forwarded verbatim; the proxy blocks
> instead if path-aware redaction leaves an expected match behind.*

Also catches write-back bugs (placeholder put in the wrong JSON node). Retries reuse the
anonymized body — the raw body is never a fallback.

### Strength of the guarantee
- **Registered exact values** (ficta reads the same `.env`/Doppler source as the agent): literal
  string match in covered request surfaces, no pattern guessing.
- **Path caveat:** filesystem-path-like tokens are skipped by default in the shipped
  implementation; set `FICTA_REDACT_PATHS=1` to redact inside paths too.
- **Unknown-format secrets:** best-effort only. Pattern detection cannot *prove* a negative against
  arbitrary unknown strings — stated honestly.

### Placeholders leak nothing useful
The shipped implementation uses deterministic keyed `FICTA_<hex>` surrogates. The vault holds
surrogate⇄value mappings in memory; upstream sees only opaque local tokens, not raw values.

### Never kept beyond the local session, never logged by default
- Vault mappings are in-memory and are not intentionally written to disk or printed.
- Raw body logging is opt-in (`FICTA_LOG_LEVEL=trace`) because raw request/response bodies can contain
  real secrets. It is runtime-only (never persisted to `config.toml`); leave the level at `info` or
  below for normal use.
- **Retention = agent session/proxy lifetime** in the shipped implementation: values remain in RAM
  long enough for deterministic multi-turn redaction/restore, then disappear when the wrapper exits.

### Honest caveats
- Plaintext secret **must** reside in RAM during the round-trip (reversibility requires it);
  we minimize the window and never persist.
- **Guaranteed memory zeroization / anti-swap is not possible in pure Node** (immutable,
  GC'd strings). **Decision: stay Node and document this gap.** It only matters to an
  attacker already able to read process memory / core dumps / swap *after* a round-trip —
  a live in-flight attacker would have seen the value regardless. If this guarantee later
  becomes a hard requirement, port just the vault core to a Rust addon
  (locked buffer + `mlock` + zeroize-on-drop); the proxy shell stays as-is.

### Tooling
`pnpm`, TypeScript, `tsx` (dev), `vitest` (tests), `undici`/native fetch. No Python, no
native deps in the MVP.

## Phasing
- **MVP:** Node/TS proxy; shared core; Anthropic + OpenAI adapters; reversible vault;
  non-streaming **and** streaming restore; fail-closed default; vitest suite.
- **Built:** the PII detector plugin with config-driven backends — the in-process `regex` backend
  and an out-of-process Presidio analyzer sidecar (`presidio`) for names/orgs/locations NER, selected
  via `[pii] backend` (`src/plugins/pii/`, see [`plugins.md`](./plugins.md)). Detection stays
  best-effort and secondary to the exact-match secret registry.
- **Possible later work:** user-defined custom patterns, allow/deny lists, and more adapters — also
  best-effort and secondary to the exact-match secret registry.

## Layout

```
ficta/
  README.md
  docs/architecture-plan.md
  package.json            # pnpm
  tsconfig.json
  vitest.config.ts
  src/
    server.ts             # proxy shell, routing, upstream forwarding
    config.ts             # env parsing
    core/
      detectors.ts
      vault.ts
      stream-restorer.ts
      sse.ts
    adapters/
      types.ts            # ProviderAdapter interface
      anthropic.ts
      openai.ts
  test/
    detectors.test.ts
    vault.test.ts
    stream-restorer.test.ts
    roundtrip.test.ts     # adapter request→restore round-trips
    integration.test.ts   # mock upstream (JSON + SSE), both wire formats
```

## Build order
1. `git init` + scaffold (`package.json`, `tsconfig.json`, `vitest.config.ts`).
2. Core string-level logic + tests first: `detectors` → `vault` → `stream-restorer`.
3. `ProviderAdapter` interface + Anthropic + OpenAI adapters + round-trip tests.
4. Proxy shell (`server.ts`, `config.ts`) + integration tests against a mock upstream.
5. Manual end-to-end against Claude Code (`ANTHROPIC_BASE_URL`) and Codex (`OPENAI_BASE_URL`).

## Verification
1. `pnpm test` (vitest): detector units (positive + no false-positive on code); vault
   determinism (same value → same placeholder); round-trip `restore(anonymize(x))==x` for
   text and tool-call args; `StreamRestorer` split at **every** byte boundary of a
   placeholder; one adapter-shape test per wire format.
2. Integration: mock upstream echoing placeholders back as (a) JSON and (b) SSE, for both
   Anthropic and OpenAI shapes → client receives restored real values; the upstream-received
   body contains **only** `«HR:…»` placeholders.
3. Manual: set `ANTHROPIC_BASE_URL` (Claude Code) and `OPENAI_BASE_URL` (Codex) to ficta;
   send a message with a fake secret + email; capture the upstream request and confirm it's
   fully tokenized, while the client-visible response (one streamed, one non-streamed)
   restores real values. Optionally point a per-provider upstream at headroom to prove the
   chain composes.
4. Stability: two requests with the same email yield the same placeholder.
