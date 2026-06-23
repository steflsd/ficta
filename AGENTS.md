# Development Rules

## Changelog

Location: `CHANGELOG.md`.

For any meaningful change, update the `## Unreleased` section before finishing. A meaningful change is anything users or maintainers would expect to see in release notes, including:

- new features, commands, integrations, or supported flows;
- bug fixes;
- changed CLI behavior, config, defaults, public APIs, docs, or security/threat-model claims;
- removals or deprecations; and
- release, packaging, install, or upgrade behavior changes.

Rules:

- Read the current `## Unreleased` section before editing it.
- During normal development, only edit `## Unreleased`.
- Treat previously released version sections as immutable history. Do not add, remove, move, rewrite, or recategorize bullets in released sections.
- The only exception is the release script's promotion step, which turns the current `## Unreleased` notes into a new version section at release time.
- Use clear categories when helpful: `### Added`, `### Changed`, `### Fixed`, `### Removed`, or `### Security`. If `## Unreleased` is using plain bullets, keep that style instead of adding empty headings.
- Skip changelog entries for purely internal refactors, test-only changes, formatting, or agent-instruction-only changes that do not affect shipped behavior.
- When unsure whether a change is meaningful, add a short changelog bullet.
