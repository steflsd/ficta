![ficta — a local secret airlock for coding agents](assets/ficta-overview.png)

# ficta

ficta sits between your coding agent and the model provider. It replaces the secret values you
already manage in `.env`, process env, or Doppler with deterministic placeholders before model
requests leave your machine, then restores the real values locally so your agent can still edit
files and run commands normally.

If a protected value would be sent verbatim in a surface ficta redacts, ficta blocks the request
instead of forwarding it. The exact boundary and deliberate exceptions are scoped below.

## Who it's for

Individual developers using the coding agents ficta supports today — **Claude Code**, **Codex**, and
**Pi** — who do not want real keys copied into provider request logs or long-lived model context.

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

If you want the bare `ficta` command to point at your checkout while developing:

```sh
pnpm add -g "$(pwd)"
ficta --version  # shows +dev from a source checkout
```

## What ficta protects

ficta's exact guarantee is intentionally narrow:

- protects **registered values in their verbatim form** after registry filters and exclusions;
- redacts covered request bodies, query strings, and non-auth headers;
- fail-closes if a protected value survives redaction in a surface ficta is supposed to redact;
- restores placeholders locally on model responses.

By default, ficta discovers values from:

- `.env` and `.env.local`;
- Doppler's current config, when the Doppler CLI is available;
- secret-ish process env names such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AWS`, `OPENAI`, etc.

Registry sources skip values shorter than `registry.min_len` / `FICTA_REGISTRY_MIN_LEN` (8 by
default) and may apply trusted policy exclusions for known metadata names.

The built-in auth-header allowlist (`Authorization`, `Proxy-Authorization`, `x-api-key`, and
`Cookie`) passes through because upstream providers need those headers. Other headers are treated as
non-auth headers and may be redacted if they contain registered values.

## What ficta does not protect

ficta does not claim full prompt privacy or full DLP coverage.

Out of scope:

- unregistered, filtered-out, or transformed values, such as base64/URL-encoded/split secrets;
- registered values when they appear in filesystem-path-like tokens, unless `FICTA_REDACT_PATHS=1`;
- secrets sent by the agent through tool execution, `curl`, MCP tools, or custom scripts;
- binary responses and arbitrary non-model network egress;
- using ficta as a sandbox or compliance control.

See [`docs/threat-model.md`](./docs/threat-model.md) for the full boundary.

## Supported agents

| Agent | Status | Notes |
| --- | --- | --- |
| Claude Code | Verified | Uses Anthropic base URL routing. |
| Codex | Verified | Supports API-key and ChatGPT/OAuth flows. |
| Pi | Verified | Routes built-in `anthropic`/`openai`/`openai-codex` providers via an ephemeral `PI_CODING_AGENT_DIR` + `models.json` base-URL override. |

"Verified" means the adapter is covered by automated routing/redaction tests and maintainer local
runs, including a live end-to-end check (`pnpm test:e2e`) that drives the real agent against the
real provider and asserts a canary secret is redacted on the wire (see
[`test/e2e/README.md`](./test/e2e/README.md)). Agent CLIs change over time, so run
`ficta doctor <agent>` before relying on a setup.

ficta only supports CLI agents that route **all** of their model traffic through its proxy. **IDE
clients such as Cursor are not supported** — their agentic features (Agent, Edit, Tab) bypass a
custom base URL, so secrets could reach the provider unredacted. See the
[threat model](./docs/threat-model.md#ide-clients-cursor-etc).

Pi notes: only the built-in `anthropic`/`openai`/`openai-codex` providers are routed; user-defined
providers point at their own upstreams and are not covered.

Non-model commands such as `--help` and `--version` pass through to the real agent without starting
a proxy.

## How it works

1. `ficta setup` writes local config to `~/.ficta/config.toml`.
2. `ficta install` can add transparent `claude` / `codex` / `pi` shims to `~/.ficta/bin`.
3. Each agent run starts an ephemeral loopback proxy for that session.
4. Registry sources load exact values into memory.
5. Outbound model requests are redacted and checked fail-closed.
6. Model responses are restored locally before your agent sees them.

Raw request/response body logging is off by default. Each run writes local metadata-only
protection stats (`stats.json`) under the run log directory, and the wrapper prints a session
summary on exit. ficta has no telemetry.

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
