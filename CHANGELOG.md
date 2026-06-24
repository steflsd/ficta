# Changelog

## Unreleased

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
