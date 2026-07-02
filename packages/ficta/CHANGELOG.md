# Changelog

## Unreleased

### Added

- PII detection is now scoped **per surface**. Launched coding agents (`ficta claude|codex|pi`) keep PII detection **off by default even when `[pii] enabled` is on**, because tokenizing an email inside code you're editing is rarely wanted; re-enable it for agents with the new `[pii] agents` ↔ `FICTA_PII_AGENTS` (default off). The web/standalone proxy is unchanged — it still follows `[pii] enabled`. An explicit shell `FICTA_PII_ENABLED` still wins for a single agent run (the documented escape hatch); otherwise an agent gets PII only when both `[pii] enabled` and `[pii] agents` are true. `ficta setup` now asks a second, default-no prompt for agent-launch PII, the startup banner shows a `pii: on/off` line for the session, and `ficta doctor` reports both surfaces. See `docs/plugins.md`.
- Made the PII detection backend selectable and added a Microsoft Presidio backend. The active backend is chosen via `FICTA_PII_BACKEND` ↔ `[pii] backend` (default `regex`, so existing behavior is unchanged) — a registry of backends with exactly one selected at a time. The new `presidio` backend plugs in behind the existing `PiiRecognizer` seam and calls a `presidio-analyzer` REST sidecar (`POST /analyze`) for each request body — header/query surfaces stay regex-based — mapping detected spans to the same tokenize-on-egress / restore-on-response path as any protected value, with an entity allowlist, score threshold, minimum length guard, and correct code-point offset handling. You run the sidecar (e.g. via Docker) and point ficta at it with `[pii.presidio] url` (`FICTA_PII_PRESIDIO_URL`, default `http://127.0.0.1:5002`); language, score threshold, entity allowlist, and timeout are configurable. See `docs/plugins.md`.
- `ficta setup` now prompts for the PII backend (and, for Presidio, the URL and the fail-closed choice) when PII detection is enabled, persisting `[pii] backend`, `[pii.presidio] url`, and `[pii] fail_closed`.
- `ficta doctor` now probes the Presidio sidecar's `/health` when `presidio` is the selected PII backend and warns if it is unreachable, and warns about an unknown configured backend name.
- Added a configurable, **core-enforced** detector failure policy. When a detector backend can't run (e.g. the Presidio sidecar is down), the decision to fail-open (skip detection and forward) or fail-closed (block with a `503 ficta_blocked`) is resolved as *per-detector override ?? global default*: a global `[detection] fail_closed` ↔ `FICTA_FAIL_CLOSED_DETECTION` (default off) applies to all detectors, and `[pii] fail_closed` ↔ `FICTA_PII_FAIL_CLOSED` overrides it for PII (unset = defer to the global). The detector only *signals* the outage (a new `DetectorPlugin.failClosed()` exposes config); the engine resolves the policy and the transport returns the 503 — plugins never enforce. Independent of the global `FICTA_FAIL_CLOSED`, which guards registered-secret leaks (different condition, default on).
- Added a safe proxy `/__ficta/status` endpoint plus internal web-chat badge/banner polling so Presidio outages are visible in the UI, including whether the active detector policy is fail-open (forwarding without Presidio screening) or fail-closed (blocking before the model).
- Added text-file attachments to the internal web chat. Supported text files are inlined into the chat request so ficta can redact them, while PDF/DOCX uploads are blocked with a warning to paste the relevant context until local extraction exists.
- Added self-serve WorkOS workspace onboarding and in-app workspace creation so org-less users can create or select an organization without using the WorkOS dashboard.

### Changed

- Updated README artwork to load from the root `assets/` directory and show the registered-secret and PII gateway flows separately.
- Moved the web chat thread sidebar onto TanStack Query and now creates the thread as soon as the first message is sent, so new chats appear in the sidebar immediately instead of waiting for a navigation, reload, or completed response. Starting a new chat now focuses the composer automatically.
- Updated the root, package, and web README docs plus `config.toml.example` to describe the current web UI / PII gateway flow, PII detector backends and per-surface defaults, Presidio as a first-class externally run sidecar backend with Docker examples, Presidio outage posture, web status polling, attachments, WorkOS workspaces, and storage configuration.
- Made the PII detector outage posture more visible without changing the fail-open runtime default (a detector outage stays best-effort-degraded, not a hard block, per `docs/threat-model.md`). `ficta setup` now defaults the Presidio fail-closed prompt to **Yes** — someone who deliberately picks the heavyweight sidecar is the user most likely to want its outages enforced — while still respecting an explicit prior choice and leaving the runtime default (`FICTA_PII_FAIL_CLOSED`/`FICTA_FAIL_CLOSED_DETECTION`) fail-open. The startup banner's `pii:` line now states the resolved posture (`skips on backend outage` vs `blocks on backend outage`). And an unreachable backend now **re-warns every 5 minutes** (carrying the running failure count) instead of warning only once, so a sidecar that stays down keeps surfacing in logs.
- Tightened the internal web chat sidebar and settings UI toward ChatGPT-style proportions. Settings now opens as a compact autosaving chat overlay dialog from the sidebar instead of navigating to a settings page, and duplicate chat/sidebar-owned actions were removed from the top bar.
- Clarified `ficta setup` prompts so each question names its module or registry source, and explained the registry minimum-length filter in plain language.
- Replaced the separate root `dev:doppler` workflow with a `scripts/dev.mjs` wrapper behind `pnpm dev`; it auto-runs `doppler run -- pnpm dev:all` when Doppler is configured, otherwise loads local `.env` files and starts the proxy + web app without Doppler.
- The PII detection backend is now purely exclusive — the selected backend is the only backend, with no cross-backend fallback. If the selected backend can't run, behavior follows the core-enforced detector failure policy (see Added): fail-open skips detection for that request, fail-closed blocks it. The startup banner and `ficta doctor` show the active backend, the resolved failure mode, and the last recorded sidecar failure.
- Consolidated the four ad-hoc verbosity flags into one leveled env var, `FICTA_LOG_LEVEL` (`silent` < `error` < `warn` < `info` < `debug` < `trace`; default `info` standalone, and the agent wrapper sets `silent` so proxy output never garbles the TUI). `trace` is the raw-body tier — it writes real request/response bodies to disk — so, like the old `FICTA_LOG_BODIES`, it is runtime-only and never persisted to `config.toml`. `ficta doctor` reports the active level and still warns when `trace` is set. This is a clean break with no compatibility aliases:

  | Removed | Replacement |
  | --- | --- |
  | `FICTA_SILENT=1` | `FICTA_LOG_LEVEL=silent` (the wrapper's default) |
  | `FICTA_QUIET=1` / `[runtime] quiet` | default `FICTA_LOG_LEVEL=info` — non-model (unknown-wire) request lines now need `debug` |
  | `FICTA_LOG_BODIES=1` / `[logging] log_bodies` | `FICTA_LOG_LEVEL=trace` (also unmutes the console, so under a wrapped agent it now garbles the TUI — capture bodies with the standalone proxy) |
  | `FICTA_VERBOSE=1` | `--ficta-verbose` (startup diagnostics only; proxy logs stay silent) or `FICTA_LOG_LEVEL=debug` |

  Stale `log_bodies` / `quiet` keys in an existing `config.toml` are ignored (they no longer map to anything) and dropped the next time `ficta setup` rewrites the file.
- Proxy runtime logging now runs on **pino** (with **pino-pretty**). All proxy log output — the listening banner, per-request `→`/`←` summaries, `🔒 kept` / `♻️ restored`, and upstream/blocked errors — is emitted as structured records to **stderr** (stdout belongs to the wrapped agent's TUI): colorized and human-readable when stderr is an interactive terminal, newline-delimited JSON when redirected or piped (aggregator-friendly; `pid`/`hostname` omitted). `FICTA_LOG_LEVEL` maps directly onto pino's levels, so the level semantics above are unchanged. Command *results* — `ficta --version`, `--help`, the `doctor` report, and `install`/`uninstall`/`enable`/`disable` status — stay plain stdout/stderr so scripts and pipes keep working. The compact aligned startup box is replaced by the structured `ficta listening …` record; per-source registry discovery detail (the old `--ficta-verbose` report) now logs at `debug`.

### Fixed

- Fixed request-time proxy logs appearing inside Claude Code/Pi TUIs in source-checkout launches by making the pino logger initialize lazily after the agent wrapper sets `FICTA_LOG_LEVEL=silent`. `FICTA_LOG_LEVEL` remains the single request-time logging control: leave it unset/`silent` for clean wrapped-agent TUIs, or explicitly set `info`/`debug`/`trace` for terminal proxy logs while debugging. The shutdown stats summary is also suppressed for default interactive launches.

## 0.1.0-beta.7 - 2026-07-01

### Added

- Added opt-in, best-effort PII detection. A new built-in `pii` detector plugin redacts structured PII — email addresses, US SSNs, and Luhn-validated card numbers — through the same tokenize-on-egress / restore-on-response path as registered secrets. It is off by default for an unconfigured proxy (enable with `FICTA_PII_ENABLED=1` or `pii.enabled`; `ficta setup` now defaults it on — see below), and detection backends are pluggable behind a new exported `PiiRecognizer` contract so an out-of-process NER/Presidio recognizer can be added later. Detection is best-effort — a reduction, not the exact-match guarantee registered values receive.
- Made PII detection request-scoped. Each request opens an ephemeral vault layer over the shared permanent (registered-secret) layer via a new `RedactionEngine.beginRequest(scopeKey?)` seam; values detected while redacting a request are tokenized and restored only for that request, then discarded when the handler returns. This bounds detected-value memory and closes a cross-client leak (one client's detected PII can never be restored into another's response, since detected surrogates are private to the scope). `scopeKey` is the reserved seam for a future persistent session/org vault; ignored today.
- Added a restore-count log line symmetric with the egress line: responses log `♻️ ficta #N — restored M value(s) in response` alongside `🔒 ficta #N — kept N body value(s)`, so the round-trip is visible from the console. The count spans buffered and streaming restore and is suppressed when zero.

### Changed

- `ficta setup` now defaults PII detection **on**. Standing up the gateway implies wanting detection, so the wizard prompt defaults to yes and names the active recognizer; the "best-effort MVP" caveat applies to the current recognizer's coverage, not the concept. The No path remains for shared-proxy/CLI use where the regex could tokenize an email in agent code, and `FICTA_PII_ENABLED=0` is still an explicit force-off. An unconfigured proxy (no `ficta setup`, no env) stays off.
- Detector plugins now report an `active` discovery status instead of a misleading value count. An enabled detector holds no preloaded values — it matches each request at runtime — so the startup banner and `ficta doctor` show `✓ PII detector — active …` rather than `! PII detector (0 values)`, which read as idle.
- Detectors are now first-class config-driven plugins. A `DetectorPlugin` may declare `config`/`setup`/`discover` (previously exclusive to registry sources), so a detector self-gates on its own `enabled` flag and surfaces in `ficta setup`, `config.toml`, and the startup banner; `loadValues` stays registry-source-only. The detection path is also now asynchronous — plugin `detectText` may return a `Promise`, which the engine awaits on the request path — so recognizers can call out of process. Both are exposed through the `@steflsd/ficta/plugins` entry point.
- Restructured the repository into a pnpm workspace: the package moved from the repo root to `packages/ficta`, with the root now a private orchestrator and a new `apps/web` chat UI alongside it. The published `@steflsd/ficta` package is byte-for-byte unchanged (identical tarball). Source-checkout developers must re-run `ficta install` after pulling, because the dev shim's launcher records an absolute path to `bin/ficta.mjs`.

## 0.1.0-beta.6 - 2026-06-30

### Added

- Added local metadata-only protection stats for each proxy run, including a shutdown summary and `stats.json` with counts by model, surface, wire, and protected label.
- Added an opt-in live end-to-end protection check (`pnpm test:e2e`, or `pnpm verify:live`) that launches each real agent (Claude Code, Codex, Pi) through ficta against the real provider, makes it read a sample `.env`, and asserts the canary value is redacted on the wire (placeholder present, literal absent) with the local restore round-trip checked. It is excluded from the default offline suite/CI and self-skips per agent when the real binary or provider auth is absent.

### Changed

- Documented that IDE clients such as Cursor are out of scope: only CLI agents that route all model traffic through the proxy are supported, since Cursor's Agent/Edit/Tab features bypass a custom base URL and could reach the provider unredacted. Recorded the boundary in `docs/threat-model.md` and the README supported-agents section.

### Fixed

- Fixed the Pi adapter, which did not actually route model traffic through ficta. Pi ignores an extension's `registerProvider({ baseUrl })` override (it patches model copies after load and the override never reaches the request layer), so the previous temp-extension approach left Pi talking directly to the real backends — including the user's default `openai-codex` provider. ficta now launches Pi with `PI_CODING_AGENT_DIR` set to an ephemeral agent dir that mirrors the user's real auth/settings and swaps in a generated `models.json` overriding the base URLs of the built-in `anthropic`/`openai`/`openai-codex` providers, the only override Pi reliably honors. Redaction and restore round-trip are verified live for `openai-codex`/`gpt-5.5`; user-defined providers point at their own upstreams and remain unrouted.
- Restored surrogates in streamed SSE responses that arrive with no `content-type` header — notably the ChatGPT/Codex backend (`/backend-api/codex/responses`). Previously the missing content-type made the restore check fail closed-to-passthrough, so `FICTA_…` placeholders leaked into the agent's output instead of the real values. ficta now treats a content-type-less response on a known model wire (anthropic / openai-chat / openai-responses) as that wire's event stream and restores it. This is what let Pi's `openai-codex` path complete its round-trip.

## 0.1.0-beta.5 - 2026-06-30

### Changed

- Clarified README and threat-model wording for registry filters, path-like-token preservation, auth-header pass-through scope, and supported-agent verification status.
- Consolidated boolean env-flag parsing into a single `src/env-flags.ts` (`parseBoolean`/`envFlag`/`envEnabled`) and deduplicated `isRecord`, removing ~7 drifted copies across config, CLI, doctor, vault, user-config, and plugins.
- Routed all fail-closed 403s through a single shared builder so the query/body/header surfaces stay in lockstep, added blocked-leak logging to the query surface, and reduced redundant registry rebuilds during body inspection.
- Routed both the buffered (streaming-JSON and non-streaming) response paths through a single restore-by-content-type helper so the JSON-vs-text restore decision lives in one place.

### Fixed

- Fixed fail-closed leak detection for registered numeric-looking values sent as JSON number primitives; the backstop now matches a value only as a complete primitive token, so a registered number is never falsely flagged when it merely appears as a substring of a larger unrelated number (e.g. `12345678` inside `99912345678`).
- Hardened Doppler registry loading by refusing a Doppler executable file that is itself world-writable.
- Redacted registered secret values that appear percent-encoded in request query strings; the query surface now decodes each parameter to redact and the fail-closed leak check sees the real plaintext, while re-encoding only the parameters it actually changed so untouched, encoding-sensitive parameters keep their wire bytes verbatim.
- Treated only genuine `127.0.0.0/8` dotted-quad literals as loopback when applying the custom-upstream gate; lookalike DNS names such as `127.foo.com` and `127.0.0.1.attacker.example` are no longer mistaken for loopback.
- Honored all truthy spellings (`yes`, `on`, `enabled`, …) for boolean env flags consistently; previously `FICTA_REDACT_PATHS=yes` was silently ignored because the vault's parser accepted only `1`/`true`.
- Kept JSON response bodies valid when a restored value contains JSON-special characters (quotes, backslashes, newlines): surrogates are now restored in place with each value escaped for its JSON string context, instead of a `JSON.parse`/`JSON.stringify` round-trip that silently rounded integers beyond 2^53 and reformatted numbers in otherwise-unchanged responses.
- Streamed newline-delimited JSON (`application/x-ndjson`, `application/json-seq`) responses now pass through the streaming restore instead of being buffered in full and run through the single-document JSON restore; only true JSON bodies are buffered.
- Stopped registering shell `PWD`/`OLDPWD` as protected secrets (which redacted the working directory) while keeping every other `PWD`-bearing credential name covered (`DB_PWD`, `ADMINPWD`, `PWDHASH`, …), not only the `_PWD` underscore form.
- Fully restored surrogates in SSE sibling fields and non-fragment event records (JSON-safe) without re-serializing the event, so large integers and number formatting in non-fragment events are preserved.

## 0.1.0-beta.4 - 2026-06-26

- Added a public `./plugins` entry point (`@steflsd/ficta/plugins`) exposing the plugin contract types and built-in plugin API, with TypeScript declaration output (`declaration: true`) so the types ship in the package.
- Pruned dead code surfaced by `knip`: demoted ~26 internal-only symbols from exported to module-private, deleted two genuinely-unused helpers (`pluginsHaveDetectors`, `resetUserConfigForTests`), and removed stale barrel re-exports in `plugins/index.ts` and `log.ts`. `knip` now reports zero findings.
- Added trust-gated registry-policy exclusions: a plugin may declare safe metadata-only env-name exclusions, but core only enforces them for trusted built-ins and applies them at every named-value ingress (registry load, detector output, and caller-supplied values). The built-in Doppler plugin uses this to exclude `DOPPLER_CONFIG`/`DOPPLER_ENVIRONMENT`/`DOPPLER_PROJECT` metadata while `DOPPLER_TOKEN` stays protected by the secret-ish heuristic. The startup banner and `ficta doctor` now report enforced exclusions per source (e.g. `process env 95 (3 excluded)`) and account for them separately from dedupe in the loaded-vs-protected count; the verbose banner lists only enforced rules while `ficta doctor` also shows declared-but-untrusted ones. Policy validation rejects unknown fields and invalid env-name identifiers.

## 0.1.0-beta.3 - 2026-06-25

- Updated Hono to 4.12.27 and Biome to 2.5.1.
- Fixed streamed SSE restore when supported provider deltas split a `FICTA_...` surrogate across events.
- Fixed GitHub Actions pnpm setup by relying on `packageManager` as the single pinned pnpm version.

## 0.1.0-beta.2 - 2026-06-24

- Hono 2.0.6
- Hardened Doppler registry loading by refusing project-local/world-writable Doppler commands and running the Doppler subprocess with a minimal environment.
- Added custom upstream guardrails: non-default non-loopback upstreams now require `FICTA_ALLOW_CUSTOM_UPSTREAM=1`, and remote custom upstreams must use HTTPS.
- Improved registry-source failure handling so strict registry mode blocks on source errors, env-file read errors are reported per file, and detector plugin exceptions do not take down proxy requests.
- Improved `.env` compatibility for common double-quoted escape sequences such as `\n`.
- Added `FICTA_LOG_MAX_BYTES` to cap response log/inspection buffering.
- Simplified the Doppler setup prompt to global active/all coverage choices while keeping named configs available via manual config/env overrides.
- Added development guidance requiring `CHANGELOG.md` updates for meaningful changes.
- Added `ficta --version` / `ficta version`, showing `+dev` when running from a source checkout.
- Reformatted `ficta --help` into standardized sections with aligned commands and a shorter common environment section.
- Documented `pnpm add -g "$(pwd)"` for source-checkout developers who want a bare local `ficta` command.
- Made setup preselect the Doppler registry source only when Doppler is explicitly enabled or the Doppler CLI is detected on `PATH`.
- Moved registry-source setup/config/default metadata behind an explicit `kind: "registry-source"` plugin contract, with validation that fails non-compliant registry providers.

## 0.1.0-beta.1 - 2026-06-23

- Added `ficta disable` and `ficta enable` to globally bypass/re-enable installed shims without uninstalling.
- Changed shim installation to use a hidden `~/.ficta/bin/.ficta-launcher`, so `~/.ficta/bin` does not shadow the global `ficta` command.
- Documented npm, pnpm, and bun global install commands.
- Added a Pi-style release flow: local release script bumps `package.json`, promotes `CHANGELOG.md`, commits/tags, and tag-triggered GitHub Actions publishes to npm with provenance.

## 0.1.0-beta.0

Initial npm beta release.

- Local redaction proxy for Claude Code, Codex, and Pi.
- Registry-source support for `.env`, process environment, and Doppler-managed values.
- Deterministic surrogate replacement, local restore, and fail-closed outbound leak checks for registered values.
- CLI setup, doctor, install, uninstall, and per-agent launch commands.
