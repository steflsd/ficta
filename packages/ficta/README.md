![ficta — a local secret airlock for coding agents](assets/ficta-overview.png)

# @steflsd/ficta

Local redaction proxy for coding-agent and web-chat model traffic. ficta sits between the client and
the model provider, replaces registered secret values with deterministic placeholders before requests
leave your machine/server, and restores them locally on the response — so tools and users keep seeing
those protected values while the provider sees surrogates. Optional PII detector backends add
best-effort tokenization for pasted sensitive text; they are a reduction layer, not the exact-match
guarantee registered secrets receive.

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
| `detection.fail_closed` | `FICTA_FAIL_CLOSED_DETECTION` | `false` | Global default for detector-backend outages: block instead of skip detection. |
| `pii.enabled` | `FICTA_PII_ENABLED` | unconfigured: `false`; after `ficta setup`: prompted, default `true` | Best-effort PII detection for the standalone/web proxy. |
| `pii.agents` | `FICTA_PII_AGENTS` | `false` | Also enable PII detection for `ficta claude|codex|pi` launches when `pii.enabled` is on. |
| `pii.backend` | `FICTA_PII_BACKEND` | `regex` | PII backend: `regex` or `presidio`; exactly one runs. |
| `pii.fail_closed` | `FICTA_PII_FAIL_CLOSED` | `false` | PII-specific detector-outage policy; overrides `detection.fail_closed`. |
| `pii.presidio.url` | `FICTA_PII_PRESIDIO_URL` | local Presidio sidecar URL | Analyzer URL when `pii.backend = "presidio"`. |
| `logging.log_dir` | `FICTA_LOG_DIR` | `~/.ficta/logs` | Where per-run logs and `stats.json` are written. |
| `upstreams.anthropic` | `FICTA_ANTHROPIC_UPSTREAM` | Anthropic API | Override the Anthropic upstream (also `..._OPENAI_...` / `..._CHATGPT_...`). |

**Registry sources** — env-file, process-env, and Doppler discovery — have their own config under
`[registry.*]`; see [`docs/plugins.md`](./docs/plugins.md#configuring-built-in-plugins) for the
per-source options (Doppler `configs` / `project` / `timeout_ms`, etc.).

**PII detection** is intentionally per-surface. The standalone/web proxy follows `pii.enabled`. A
launched coding agent gets PII detection only when both `pii.enabled` and `pii.agents` are true,
unless you explicitly set `FICTA_PII_ENABLED=1` or `0` for that single run.

**Presidio is a first-class supported PII backend, not a bundled service.** Select it with
`pii.backend = "presidio"` / `FICTA_PII_BACKEND=presidio`; ficta will call the configured
`presidio-analyzer` URL, check `/health` in `ficta doctor` and the web UI status endpoint, and apply
the configured fail-open/fail-closed detector-outage policy. You must run the analyzer sidecar
separately, usually with Docker for local development:

```sh
docker run --rm -p 5002:3000 mcr.microsoft.com/presidio-analyzer:latest
FICTA_PII_ENABLED=1 \
FICTA_PII_BACKEND=presidio \
FICTA_PII_PRESIDIO_URL=http://127.0.0.1:5002 \
pnpm dev
```

See [`docs/plugins.md#built-in-detector-plugin-pii`](./docs/plugins.md#built-in-detector-plugin-pii)
for backend selection, Presidio sidecar setup, and fail-open/fail-closed behavior when a detector
backend is unavailable.

### One-off overrides

```sh
FICTA_REQUIRE_REGISTRY=1 claude   # refuse to launch if nothing loads
FICTA_REDACT_PATHS=1 claude       # also redact path-like tokens this run
FICTA_LOG_LEVEL=trace claude      # verbose logs incl. raw bodies (debug only)
FICTA_PII_ENABLED=1 claude        # force PII detection for this one agent run
FICTA_PII_BACKEND=presidio pnpm dev # use the Presidio sidecar for the web/standalone proxy
FICTA_DISABLE=1 claude            # bypass an installed shim once
ficta disable                     # bypass all shims until `ficta enable`
```

`FICTA_LOG_LEVEL` (`silent` < `error` < `warn` < `info` < `debug` < `trace`; default `info`
standalone, `silent` under a wrapped agent) is runtime-only by design and is **not** persisted to
`config.toml` — `trace` writes raw request/response bodies to disk, so it must be an explicit
per-run choice, never a saved default. Under wrapped agents, leave it unset/`silent` to keep TUIs
clean; set `info`/`debug`/`trace` only when you intentionally want proxy logs in the terminal.

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
- [`docs/plugins.md`](./docs/plugins.md) — registry-source, detector, and agent-integration plugins
- [`docs/plugins.md#built-in-detector-plugin-pii`](./docs/plugins.md#built-in-detector-plugin-pii) — PII detector surfaces, backends, and failure policy
- [`docs/pii-gateway-north-star.md`](./docs/pii-gateway-north-star.md) — web-chat/PII gateway architecture notes
- [`docs/exfil-and-egress.md`](./docs/exfil-and-egress.md) — why tool-channel egress is out of scope
- [`docs/codex-oauth-intercept.md`](./docs/codex-oauth-intercept.md) — Codex ChatGPT/OAuth routing
- [`docs/benchmarks.md`](./docs/benchmarks.md) — performance notes
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`SECURITY.md`](./SECURITY.md)

## Status

Pre-1.0 beta. Core exact-match redaction, restore, and fail-closed behavior is covered by tests and
local agent runs, but run `ficta doctor <agent>` before relying on a CLI setup. Treat PII detection as
best-effort and verify web-chat deployments with fake PII before sensitive use.

## License

MIT — see [`LICENSE`](./LICENSE).
