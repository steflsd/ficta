# @steflsd/ficta

Local redaction proxy for coding agents. ficta sits between your agent and the model provider,
replaces registered secret values with deterministic placeholders before requests leave your
machine, and restores them locally on the response — so your agent keeps working with real values
while the provider never sees them.

For the full pitch, threat model, and what's in/out of scope, see the
[project overview](https://github.com/steflsd/ficta#readme) and
[`docs/threat-model.md`](./docs/threat-model.md). This page is the practical install-and-configure
reference.

## Install

```sh
npm install -g @steflsd/ficta@beta
# or: pnpm add -g @steflsd/ficta@beta  /  bun install --global @steflsd/ficta@beta
```

## First run

```sh
ficta setup              # writes ~/.ficta/config.toml; optionally installs shims
ficta doctor claude      # sanity-check registry loading + routing (or: codex / pi)
# restart your shell if setup installed shims
claude                   # now runs through ficta
```

Without shims, launch explicitly: `ficta claude` (or `ficta codex` / `ficta pi`). Non-model commands
like `--help` / `--version` pass straight through without starting a proxy. Shim details are in
[`docs/install.md`](./docs/install.md).

## Configuration

`ficta setup` writes **`~/.ficta/config.toml`**. Every option can be overridden by a `FICTA_*` shell
environment variable, and **env vars always win over the file**. Point at a different file with
`FICTA_CONFIG_FILE`.

[`config.toml.example`](./config.toml.example) is the authoritative, fully annotated reference for
every option. The table below is just a quick tour of the most useful knobs:

| TOML | Env override | Default | What it does |
| --- | --- | --- | --- |
| `registry.min_len` | `FICTA_REGISTRY_MIN_LEN` | `8` | Ignore registered values shorter than this. |
| `registry.require` | `FICTA_REQUIRE_REGISTRY` | `false` | Refuse to launch if no protected values load. |
| `registry.env_file.paths` | `FICTA_REGISTRY_ENV_FILE_PATHS` | `.env,.env.local` | Env files to load values from. |
| `registry.process_env.mode` | `FICTA_REGISTRY_PROCESS_ENV_MODE` | `secret-ish` | `secret-ish` name-matching or `all` process env. |
| `redaction.fail_closed` | `FICTA_FAIL_CLOSED` | `true` | Block a request if a protected value survives redaction. |
| `redaction.redact_paths` | `FICTA_REDACT_PATHS` | `false` | Also redact filesystem-path-like tokens. |
| `logging.log_bodies` | `FICTA_LOG_BODIES` | `false` | Log raw request/response bodies (off by default). |
| `logging.log_dir` | `FICTA_LOG_DIR` | `~/.ficta/logs` | Where per-run logs and `stats.json` are written. |
| `upstreams.anthropic` | `FICTA_ANTHROPIC_UPSTREAM` | Anthropic API | Override the Anthropic upstream (also `..._OPENAI_...` / `..._CHATGPT_...`). |

**Registry sources** — env-file, process-env, and Doppler discovery — have their own config under
`[registry.*]`; see [`docs/plugins.md`](./docs/plugins.md#configuring-built-in-plugins) for the
per-source options (Doppler `configs` / `project` / `timeout_ms`, etc.).

### One-off overrides

```sh
FICTA_REQUIRE_REGISTRY=1 claude   # refuse to launch if nothing loads
FICTA_REDACT_PATHS=1 claude       # also redact path-like tokens this run
FICTA_DISABLE=1 claude            # bypass an installed shim once
ficta disable                     # bypass all shims until `ficta enable`
```

## Commands

```sh
ficta setup        # configure registry sources and optional shims
ficta doctor       # check registry loading and agent routing
ficta install      # install transparent claude/codex/pi shims
ficta uninstall    # remove ficta-owned shims
ficta disable      # globally bypass installed shims without uninstalling
ficta enable       # re-enable installed shims globally
ficta claude       # launch an agent through ficta without shims
```

## Supported agents

| Agent | Status | Notes |
| --- | --- | --- |
| Claude Code | Verified | Anthropic base-URL routing. |
| Codex | Verified | API-key and ChatGPT/OAuth flows — see [`docs/codex-oauth-intercept.md`](./docs/codex-oauth-intercept.md). |
| Pi | Verified | Built-in `anthropic`/`openai`/`openai-codex` providers via ephemeral `PI_CODING_AGENT_DIR` + `models.json` base-URL override. |

Only CLI agents that route **all** model traffic through the proxy are supported. IDE clients such as
Cursor are not — their agentic features bypass a custom base URL. See the
[threat model](./docs/threat-model.md#ide-clients-cursor-etc).

## Documentation

- [`docs/install.md`](./docs/install.md) — shim installation and runtime behavior
- [`docs/threat-model.md`](./docs/threat-model.md) — exact promise, covered surfaces, and non-goals
- [`docs/plugins.md`](./docs/plugins.md) — registry-source and agent-integration plugins
- [`docs/exfil-and-egress.md`](./docs/exfil-and-egress.md) — why tool-channel egress is out of scope
- [`docs/codex-oauth-intercept.md`](./docs/codex-oauth-intercept.md) — Codex ChatGPT/OAuth routing
- [`docs/benchmarks.md`](./docs/benchmarks.md) — performance notes
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`SECURITY.md`](./SECURITY.md)

## Status

Pre-1.0 beta. Core redaction, restore, and fail-closed behavior is covered by tests and local agent
runs, but run `ficta doctor <agent>` before relying on a setup.

## License

MIT — see [`LICENSE`](./LICENSE).
