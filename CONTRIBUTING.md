# Contributing

Thanks for wanting to improve ficta.

ficta is pre-1.0 beta software with a deliberately narrow privacy boundary: exact registered values
in covered model-request surfaces. Please read [`README.md`](./README.md),
[`docs/threat-model.md`](./docs/threat-model.md), and [`docs/decisions.md`](./docs/decisions.md)
before changing product claims or security-sensitive behavior.

## What we want contributions to optimize for

1. **Keep the core invariant small and testable.** Plugins and integrations may report values,
   detections, or launch plans. The core engine/vault owns redaction, fail-closed leak checks, and
   restore.
2. **Do not overstate protection.** Avoid broad claims like "secure", "DLP", or "never leaks"
   unless immediately scoped to the documented exact-match, covered-surface guarantee.
3. **Prefer boring, auditable code.** This project handles secret values in memory. Simple code,
   clear tests, and explicit failure modes matter more than clever abstractions.

## Core vs plugins, providers, and addons

We want people to contribute to the core, and we also want a path for providers/addons. The seams
are intentionally narrow today and are **not a stable external plugin API yet**. Until 1.0, expect
`FictaPlugin`, `AgentIntegration`, config shape, and future hook points to change.

Use this rough split:

- **Core contributions**: redaction/restore correctness, fail-closed behavior, request-surface
  coverage, routing, config, install/setup, logging safety, performance, tests, and docs.
- **Registry-source plugins**: load exact values at launch from a trusted local source such as a
  secret manager. Discovery output must be safe metadata only; never print values. External CLI
  calls need timeouts.
- **Detector plugins**: add best-effort request-time detections. These are secondary to the exact
  registry promise and must be documented as best effort.
- **Agent integrations**: teach ficta how to launch a coding agent through the local proxy. The CLI
  still owns shim resolution, proxy lifecycle, bypass behavior, and cleanup.
- **Provider/upstream support**: discuss first. New provider support may involve routing,
  authentication assumptions, response restore behavior, and agent-specific launch details.
- **External addons/hooks**: discuss first. Dynamic loading of community code is intentionally not
  automatic today; built-ins are trusted and loaded by default.

If your change affects provider support, addon loading, hook execution, or the plugin boundary,
please open an issue/RFC before sending a large PR.

## Development setup

Requirements:

- Node.js 20+
- pnpm 11+

```sh
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

`pnpm verify` runs the main prepublish checks.

## Tests and fixtures

- Add or update tests for behavior changes.
- Use obviously fake secrets in fixtures, for example `sk-ficta-test-...` or
  `fixture-secret-value`.
- Do not paste real provider transcripts, `.env` files, Doppler output, request logs, or API keys
  into issues, tests, docs, or PR descriptions.
- If a change touches request handling, include coverage for the relevant surfaces: body, query
  string, non-auth headers, auth-header passthrough, fail-closed blocking, and restore behavior.

## Security-sensitive changes

Please be extra conservative with changes that:

- alter `Vault`, `ProtectionEngine`, request redaction, leak counting, or streaming restore;
- add raw logging or diagnostics;
- change fail-closed defaults;
- add external process execution;
- add plugin/addon loading from user projects or third-party packages; or
- change public threat-model language.

Vulnerabilities or real leaks should be reported privately using [`SECURITY.md`](./SECURITY.md),
not opened as public issues with secret material.

## Pull request checklist

Before opening a PR:

- [ ] The change is small enough to review, or has an issue/RFC first.
- [ ] Tests cover the new behavior or bug fix.
- [ ] `pnpm check`, `pnpm typecheck`, and `pnpm test` pass.
- [ ] Docs are updated if user-visible behavior or claims changed.
- [ ] No real secrets, raw body logs, or private transcripts are included.
