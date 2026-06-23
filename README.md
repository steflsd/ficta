# ficta

**A local secret airlock for coding agents.**

ficta sits between your coding agent and the model provider. It replaces the secret values you
already manage in `.env`, process env, or Doppler with deterministic placeholders before model
requests leave your machine, then restores the real values locally so your agent can still edit
files and run commands normally.

If a registered value would be sent verbatim in a covered request surface, ficta blocks the request
instead of forwarding it.

## Who it's for

Individual developers using coding agents such as **Claude Code**, **Codex**, and **Pi** who do not
want real keys copied into provider request logs or long-lived model context.

ficta is personal secret-hygiene tooling. It is **not** enterprise DLP, a compliance product, or a
sandbox.

## Quick start

Install globally with your package manager:

```sh
npm install -g @steflsd/ficta@beta
# or
pnpm add -g @steflsd/ficta@beta
# or
bun install --global @steflsd/ficta@beta
```

Then set up ficta:

```sh
ficta setup              # configure ~/.ficta/config.toml; optionally install shims
ficta doctor claude      # or: codex / pi
# restart your shell if setup installed shims
claude                   # now runs through ficta
```

No shim install:

```sh
ficta claude             # or: ficta codex / ficta pi
```

From a source checkout:

```sh
git clone https://github.com/steflsd/ficta.git
cd ficta
pnpm install
pnpm ficta setup
```

## What ficta protects

ficta's exact guarantee is intentionally narrow:

- protects **registered values in their verbatim form**;
- redacts covered request bodies, query strings, and non-auth headers;
- fail-closes if a protected value survives redaction in those covered surfaces;
- restores placeholders locally on model responses.

By default, ficta discovers values from:

- `.env` and `.env.local`;
- Doppler's current config, when the Doppler CLI is available;
- secret-ish process env names such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AWS`, `OPENAI`, etc.

Provider auth headers such as `Authorization`, `x-api-key`, and cookies pass through because the
upstream needs them.

## What ficta does not protect

ficta does not claim full prompt privacy or full DLP coverage.

Out of scope:

- unregistered or transformed values, such as base64/URL-encoded/split secrets;
- secrets sent by the agent through tool execution, `curl`, MCP tools, or custom scripts;
- binary responses and arbitrary non-model network egress;
- using ficta as a sandbox or compliance control.

See [`docs/threat-model.md`](./docs/threat-model.md) for the full boundary.

## Supported agents

| Agent | Status | Notes |
| --- | --- | --- |
| Claude Code | Verified | Uses Anthropic base URL routing. |
| Codex | Verified | Supports API-key and ChatGPT/OAuth flows. |
| Pi | Beta | Routes built-in Anthropic/OpenAI providers via a temporary Pi extension. |

Non-model commands such as `--help` and `--version` pass through to the real agent without starting
a proxy.

## How it works

1. `ficta setup` writes local config to `~/.ficta/config.toml`.
2. `ficta install` can add transparent `claude` / `codex` / `pi` shims to `~/.ficta/bin`.
3. Each agent run starts an ephemeral loopback proxy for that session.
4. Registry sources load exact values into memory.
5. Outbound model requests are redacted and checked fail-closed.
6. Model responses are restored locally before your agent sees them.

Raw request/response body logging is off by default. ficta has no telemetry.

## Common commands

```sh
ficta setup        # configure registry sources and optional shims
ficta doctor       # check registry loading and agent routing
ficta install      # install transparent claude/codex/pi shims
ficta uninstall    # remove ficta-owned shims
ficta disable      # globally bypass installed shims without uninstalling
ficta enable       # re-enable installed shims globally
ficta claude       # launch an agent through ficta without shims
```

Useful overrides and bypasses:

```sh
FICTA_REQUIRE_REGISTRY=1 claude          # refuse to launch if no protected values load
FICTA_REDACT_PATHS=1 claude              # also redact filesystem-path-like tokens
FICTA_DISABLE=1 claude                   # bypass an installed shim once
ficta disable                            # bypass all shims until `ficta enable`
```

## Status

ficta is pre-1.0 beta software. The core redaction, restore, and fail-closed behavior is covered by
tests and local agent runs, but early users should run `ficta doctor <agent>` before relying on it.

## Documentation

- [`docs/install.md`](./docs/install.md) — shim installation and runtime behavior
- [`docs/threat-model.md`](./docs/threat-model.md) — exact promise, covered surfaces, and non-goals
- [`docs/plugins.md`](./docs/plugins.md) — registry-source and agent-integration plugin details
- [`docs/exfil-and-egress.md`](./docs/exfil-and-egress.md) — why tool-channel egress is out of scope
- [`docs/codex-oauth-intercept.md`](./docs/codex-oauth-intercept.md) — Codex ChatGPT/OAuth routing
- [`docs/benchmarks.md`](./docs/benchmarks.md) — performance notes
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — contributing to core and extension seams
- [`SECURITY.md`](./SECURITY.md) — reporting vulnerabilities and expected limitations

## Development

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT — see [`LICENSE`](./LICENSE).
