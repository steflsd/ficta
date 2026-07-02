# ficta PII redaction gateway + TanStack Start chat UI — north star

> **Status:** in progress. The ficta-core backend for this gateway is largely built (see
> **Progress** below), including the Presidio recognizer. The `apps/web` TanStack Start UI is now
> built (installs, typechecks, and builds — client + SSR) but not yet exercised end-to-end against a
> live proxy + vendor; `FICTA_HOST` + Docker packaging are not built yet. North-star reference —
> captures decisions, architecture, and the intended module layout. Last updated: 2026-07-02.

## Progress

Built and verified (behind `pnpm verify`):
- **Seam contracts** — `RedactionEngine` (`src/redaction-engine.ts`), `SurrogateStrategy`
  (`src/surrogate.ts`, hex strategy injected into the vault), `PiiRecognizer`
  (`src/plugins/pii/recognizer.ts`). `server.ts` depends on the `RedactionEngine` interface, not the
  concrete engine.
- **Detectors are first-class config-driven plugins** — `DetectorPlugin` now carries optional
  `config`/`setup`/`discover` (`types.ts`); the config/setup/discovery plumbing in `plugins/index.ts`
  gathers from any plugin kind (`loadValues` stays registry-source-only).
- **PII detector MVP** — `piiPlugin` (`src/plugins/pii/index.ts`) composing a high-precision regex
  recognizer (email, US SSN, credit-card+Luhn). Off by default via `FICTA_PII_ENABLED` ↔ `pii.enabled`
  (per-surface: the standalone/web proxy honors that flag, but launched coding agents stay off unless
  `FICTA_PII_AGENTS` ↔ `pii.agents` is also set); in `defaultPlugins`; detected PII tokenized on egress
  and restored on responses.
- **Detection path is async** — `detectText` may return a `Promise`; `engine.redactBodyDetailed` /
  `redactTextDetailed` and `server.ts` await it. This is what lets an out-of-process recognizer plug in.
- **Config-driven backend selection + Presidio backend** — a single backend is selected by name via
  `FICTA_PII_BACKEND` ↔ `[pii] backend` (`src/plugins/pii/registry.ts`, default `regex`); `ficta
  setup` prompts for it. The async `presidioRecognizer` (`src/plugins/pii/presidio-recognizer.ts`)
  POSTs each request body to a `presidio-analyzer` sidecar, gates on `ctx.surface === "body"`, maps
  spans → `ProtectedValue[]` (code-point-offset safe). The selected backend is exclusive (no
  cross-backend fallback); when it can't run, `[pii] fail_closed` ↔ `FICTA_PII_FAIL_CLOSED` chooses
  between skipping detection for that request (default, warn-once) and blocking it with a 503. `ficta
  doctor` probes `/health`. Config: `[pii.presidio]` url/language/score_threshold/entities/timeout_ms.

Not built yet: `FICTA_HOST` + Docker packaging. (The `apps/web` UI is now built — see Status above.)

## Context

Goal: a **law firm** runs an internal chat assistant where lawyers paste full legal documents; ficta **best-effort strips PII before it reaches the model vendor** and restores the real values in the answer the lawyer reads.

**Decisions locked in:**
- **Trust boundary:** hide data from the **LLM vendor only**. Lawyers are trusted with client PII; the vendor is not. (This is ficta's existing model — redact before the vendor hop, restore after.)
- **PII posture:** **best-effort reduction**, positioned honestly — *not* an absolute "PII never reaches the model" guarantee. Structural: detecting unknown PII can't be complete, and fail-closed can't rescue it (it only guards *registered* exact values, `engine.ts` leak check).
- **Client:** a **custom chat UI built in TanStack Start**, in a **pnpm monorepo**. "Any model / bring-your-own-key" comes from **TanStack AI** (`@tanstack/ai`), not from adopting LibreChat/open-webui. Browser extension for real chatgpt.com/claude.ai is **documented as an alternative**, not built.

**Why the pieces fit (verified against the current code):**
- **Engine does dynamic detect→tokenize→restore, now async.** `redactBodyDetailed()` awaits `registerDetectedValues()` before redacting, which awaits each plugin's `detectText()` (sync *or* async) then `vault.register(admitted)` — so values never seen before are tokenized on egress and restored on the response, and an out-of-process recognizer can be awaited on the request path. `kind:"pii"`/`confidence:"probabilistic"` exist in the types; a detector-only engine with an empty registry is still `enabled`.
- **TanStack AI routes through ficta via a `baseURL` override.** `openaiCompatible({ baseURL, apiKey, models })` / `openaiCompatibleText(model, { baseURL, apiKey })` and native `@tanstack/ai-openai` / `-anthropic` adapters produce exactly the `/v1/chat/completions` and `/v1/messages` wire formats ficta already routes (`config.ts:64-94`). A `createFileRoute('/api/chat')` server handler streams SSE via `chat()` + `toServerSentEventsResponse()`.
- **Repo is already a pnpm workspace** (`pnpm-workspace.yaml` present, everything at root today). Tooling: Biome, Vitest, tsc, ESM, Node ≥20, pnpm 11.

## Architecture

```
Lawyer browser  (useChat)
  → TanStack Start  apps/web   /api/chat server route
        chat({ adapter: openai/anthropic({ baseURL: <ficta>, apiKey: FIRM_KEY }), messages })
  → ficta proxy   [PII detector on, empty secret registry]
        detect PII in the messages body → tokenize → forward
  → Anthropic / OpenAI          (sees tokens, never the PII)
        ← SSE tokens
  → ficta restores tokens → real PII   → relayed back through the server route
  ← lawyer sees a coherent answer with real names
```
The firm's provider key lives server-side in `apps/web` and passes through ficta untouched (auth headers are pass-through) to the vendor.

## Monorepo layout (light, "for now")
Keep the published `@steflsd/ficta` core **where it is at root** (release scripts, `.github`, `files` globs untouched) and add the UI as a workspace member:
- Extend `pnpm-workspace.yaml` to include `apps/*` (and `packages/*` for later).
- New **`apps/web`** — TanStack Start app (`@tanstack/react-start`, router, `@tanstack/ai` + `@tanstack/ai-openai`/`-anthropic`). Reuse Biome + Vitest for consistency.
- Defer a fuller reorg (moving core to `packages/ficta`, extracting a shared `packages/engine` for the browser extension) until there's a concrete reason — noted, not done now.

## Boundaries & seams (swap plugins / engines / UI by contract)
Guiding rule: every boundary is a contract; either side is replaceable without touching the other. Dependency direction always points at the interface (concrete → interface), never the reverse. The seams:

1. **UI ↔ gateway.** Browser talks only to `apps/web`'s `/api/chat` (SSE / AG-UI contract). `apps/web` talks to ficta via a single HTTP `baseURL`. → Swap the entire UI, or swap ficta for any HTTP redaction gateway, independently.
2. **Engine seam.** Introduce a `RedactionEngine` interface — exactly the methods `server.ts` consumes (`enabled`, `redactBodyDetailed`, `redactTextDetailed`, `restoreJson/Text/Stream/EventStream`). `server.ts` takes an engine (or engine factory), not `new ProtectionEngine(...)` directly. → Swap engines, and enables the per-session/per-tenant engine map from the earlier idea.
3. **Plugin seam (already exists, keep it).** `FictaPlugin` union + `kind` + `validatePluginBoundaries`; the invariant "plugins only add values; the vault owns replace/restore" (`engine.ts:54-55`). The PII detector is a `DetectorPlugin` only — returns `ProtectedValue[]`, never touches vault/engine internals.
4. **Detection-backend seam (new, inside the detector).** A `PiiRecognizer { detect(text, ctx): ProtectedValue[] | Promise<…> }` with `regexRecognizer` + `presidioRecognizer` (HTTP sidecar) implementations composed by the plugin. → Presidio swaps for spaCy / AWS Comprehend / Azure PII behind this one interface; sidecar URL is config.
5. **Surrogate seam.** Make the surrogate generator an injectable `SurrogateStrategy` (selectable per `kind`) rather than the hardcoded `FICTA_<hex>` in `vault.ts`. Ship only the hex strategy now, but the swap point exists for realistic per-kind surrogates later.
6. **Provider seam (web).** A `createModelAdapter(cfg)` factory wrapping TanStack AI adapters (provider, model, `baseURL`→ficta, server-side `apiKey`). → Swap provider/model/key via config, not code.

**Enforcement now vs later:** keep code at root and enforce these at the **module level** (each contract in its own file, dependency direction respected, no deep imports of internals) — so promoting any seam to a real `packages/*` boundary later (e.g. `packages/engine` shared with the browser extension) is mechanical, not a rewrite.

## Target file & module layout (each seam is a real module)
```
pnpm-workspace.yaml            # + apps/*  (packages/* reserved for later extraction)
apps/
  web/                         # TanStack Start chat UI
    src/routes/index.tsx       # chat screen (useChat), provider/model picker
    src/routes/api/chat.ts     # server route: chat() + toServerSentEventsResponse()
    src/lib/model-adapter.ts   # createModelAdapter(cfg)  ← provider seam (baseURL→ficta)
    app.config.ts, package.json, tsconfig.json   # Biome + Vitest reused
src/                           # existing ficta core (root package, stays put)
  config.ts                    # + FICTA_HOST
  server.ts                    # consume RedactionEngine (not `new ProtectionEngine`); bind FICTA_HOST
  redaction-engine.ts          # NEW  RedactionEngine interface  ← engine seam
  engine.ts                    # ProtectionEngine implements RedactionEngine
  surrogate.ts                 # NEW  SurrogateStrategy interface + hex strategy  ← surrogate seam
  vault.ts                     # takes an injected SurrogateStrategy
  plugins/
    index.ts                   # pii DetectorPlugin, gated on FICTA_PII_ENABLED (pii.enabled)
    pii/
      index.ts                 # DetectorPlugin: composes recognizers → ProtectedValue[] kind:"pii"
      recognizer.ts            # NEW  PiiRecognizer interface  ← detection-backend seam
      regex-recognizer.ts      # structured PII (email/SSN/card+Luhn/phone/IP/…)
      presidio-recognizer.ts   # HTTP client to the Presidio/NER sidecar
deploy/
  Dockerfile.proxy
  docker-compose.yml           # ficta proxy + apps/web + presidio sidecar
docs/
  pii-gateway-north-star.md    # this design doc
  threat-model-pii.md          # best-effort positioning addendum (future)
```

## Work
1. **Networked proxy foundation.** Sole code blocker: hardcoded bind host at `src/server.ts:268`. Add `FICTA_HOST` to `Config` (`src/config.ts:19-55`), default `127.0.0.1`, container sets `0.0.0.0`. Proxy already runs standalone (`src/server.ts:511`). `Dockerfile` + compose. **fail-closed OFF** here (doesn't help PII).
2. **PII detector plugin** — a `DetectorPlugin` (`kind:"detector"`, `detectText`) emitting `ProtectedValue`s with `kind:"pii"`; the engine wires tokenize+restore.
   - **Structured, in-process, high precision — DONE:** `regexRecognizer` covers email, US SSN, credit-card (Luhn). Easy additions: phone, IP, bank/routing, DOB.
   - **Unstructured, out-of-process — TODO:** names/addresses/orgs via a **Microsoft Presidio** (or NER) **sidecar** — an async `presidioRecognizer` that POSTs text and maps results to `ProtectedValue[]`; gate it on `ctx.surface === "body"` so headers/query don't each hit the sidecar. The async detection path (done) is what makes this a drop-in behind `PiiRecognizer`.
   - Registered in `defaultPlugins`, **off by default** via `FICTA_PII_ENABLED` ↔ `pii.enabled` (full `config`/`setup`/`discover`, like Doppler). Posture is **per-surface**: the standalone/web proxy honors `pii.enabled`, while launched coding agents (`ficta claude|codex|pi`) require `pii.agents` too — the launcher resolves both to one effective `FICTA_PII_ENABLED` before the proxy loads.
3. **`apps/web` TanStack Start chat UI** — `/api/chat` server route using TanStack AI with the adapter `baseURL` pointed at the ficta proxy; `useChat` on the client. Provider/model picker for "any model, BYO key." Optional PII-transparency UX later (show what was redacted).
4. **Surrogate realism (optional).** `FICTA_<hex>` tokens may degrade legal reasoning; per-`kind` realistic, consistent fake surrogates preserve fluency — a `vault.ts` change. Defer unless output quality needs it.
5. **Positioning doc** — `docs/threat-model-pii.md` (style of `docs/threat-model.md`): **best-effort reduction, not a guarantee**; undetected PII can pass. Matters for the firm's own compliance claims.

## Documented-only alternative: browser extension
For teams that must use the real chatgpt.com / claude.ai UI: a WebExtension that redacts in-page *before* the request leaves the browser (hooks `fetch`/paste; no TLS MITM/CA) and restores in the DOM. Tradeoffs: separate codebase, site-specific to each private API/DOM, bypassable, and needs the detection logic shared (extract `packages/engine`, or call a firm-local endpoint). Not built here.

## Out of scope (named, not built)
- Any hard "PII never reaches the model" guarantee — impossible with detection; must not be claimed.
- Response-side PII the model itself emits (nothing to restore) — egress is the concern.
- Auth / multi-tenant isolation / TLS hardening — rely on the firm's internal network + SSO for the spike.
- Full `packages/*` reorg and native-app / MITM-DLP posture.

## Verification (end-to-end)
1. **Unit:** detector-plugin tests per regex (positives + Luhn negatives) + mocked NER sidecar. Engine round-trip (pattern from `test/server.test.ts`, loopback fake upstream via `FICTA_UPSTREAM`, `config.ts:41`): a body with a synthetic name/SSN → assert the fake upstream received **tokens** (no PII) and a token in its response is **restored** in the client-facing response.
2. **Manual:** compose up (`apps/web` + ficta + Presidio). In the TanStack Start UI, paste a synthetic legal doc of **fake** PII; confirm the fake-upstream log carried tokens, and the UI's streamed answer shows the real (fake) names — proving restore. Measure latency on a multi-page doc to size the NER sidecar.
