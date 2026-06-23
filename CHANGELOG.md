# Changelog

## Unreleased

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
