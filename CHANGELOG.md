# Changelog

## Unreleased

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
