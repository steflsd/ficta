![ficta — a local secret airlock for coding agents](packages/ficta/assets/ficta-overview.png)

# ficta

ficta is a local redaction gateway for model traffic. It can run as a secret airlock for supported
coding agents, or as the proxy behind the included internal web chat for PII-aware conversations. In
both cases, ficta tokenizes protected values before requests leave your machine or server, then
restores the real values locally on the way back.

The strongest guarantee is still exact-match protection for registered secrets you already manage in
`.env`, process env, or Doppler: if one would be sent verbatim in a surface ficta redacts, ficta
blocks the request instead of forwarding it. PII detection is available as an opt-in, best-effort
detector layer for web/chat use cases; it reduces exposure, but is not a completeness guarantee. The
exact boundary and deliberate exceptions are scoped in the
[threat model](packages/ficta/docs/threat-model.md).

## Who it's for

- Individual developers using the coding agents ficta supports today — **Claude Code**, **Codex**,
  and **Pi** — who do not want real keys copied into provider request logs or long-lived model
  context.
- Small teams piloting an internal chat assistant where users paste sensitive text and want a local
  gateway to best-effort tokenize detected PII before OpenAI/Anthropic see it, while restoring those
  values in the answer shown to the user.

ficta is secret-hygiene and best-effort PII-reduction tooling. It is **not** enterprise DLP, a
compliance product, or a sandbox.

## Quick start — coding agents

```sh
npm install -g @steflsd/ficta@beta
# or: pnpm add -g @steflsd/ficta@beta  /  bun install --global @steflsd/ficta@beta
```

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

Full install and usage docs live in the package README:
**[`packages/ficta/README.md`](packages/ficta/README.md)**.

## Web UI / PII gateway

The workspace also includes **[`apps/web`](apps/web)**, a private TanStack Start chat UI for internal
PII-aware model access. The browser talks to the app's `/api/chat` route; the server route builds an
OpenAI or Anthropic adapter with `baseURL` pointed at the ficta proxy (`FICTA_PROXY_URL`). Provider
API keys stay server-side, auth headers pass through the proxy to the vendor, and request bodies are
redacted/restored by ficta.

```txt
browser → apps/web /api/chat → ficta proxy → OpenAI / Anthropic
                         redact/tokenize      restore on response
```

Local web UI run:

```sh
pnpm install
cp apps/web/.env.example apps/web/.env
# edit apps/web/.env and set OPENAI_API_KEY and/or ANTHROPIC_API_KEY
pnpm dev
# open http://localhost:4747
```

`pnpm dev` auto-runs through Doppler when the repo has Doppler metadata; otherwise it loads local
`.env` files and starts the proxy + web app. This is only for the web-chat development flow — coding
agents still use `ficta claude|codex|pi`, which starts an ephemeral proxy per launch.

**Presidio support is first-class, but external.** ficta ships a supported `presidio` PII backend,
health checks it, reports its outage posture in `ficta doctor` and the web UI, and can fail-open or
fail-closed when it is unavailable. ficta does **not** start Presidio for you: run a
`presidio-analyzer` sidecar yourself (Docker is the easiest local path) and point ficta at it:

```sh
docker run --rm -p 5002:3000 mcr.microsoft.com/presidio-analyzer:latest
FICTA_PII_ENABLED=1 \
FICTA_PII_BACKEND=presidio \
FICTA_PII_PRESIDIO_URL=http://127.0.0.1:5002 \
pnpm dev
```

## What ficta protects

ficta has two protection layers with different guarantees:

- **Registered secrets (strong exact match):** protects registered values in their verbatim form after
  registry filters and exclusions; redacts covered request bodies, query strings, and non-auth
  headers; fail-closes if a protected value survives redaction in a surface ficta is supposed to
  redact; and restores placeholders locally on model responses.
- **Detected PII (best effort):** optionally detects PII at request time, tokenizes detected spans on
  egress, and restores them on response. The built-in backend is high-precision regex detection for
  emails, US SSNs, and Luhn-valid card numbers; Microsoft Presidio is a first-class supported sidecar
  backend for broader NER-style detection such as names, locations, organizations, and phones. The
  sidecar must already be running when you select `FICTA_PII_BACKEND=presidio`.

By default, registered-secret discovery loads values from `.env` / `.env.local`, Doppler's current
config (when the Doppler CLI is available), and secret-ish process env names such as `KEY`, `TOKEN`,
`SECRET`, `PASSWORD`, `AWS`, `OPENAI`, etc.

PII defaults are deliberately per surface: the standalone/web proxy follows `[pii] enabled`
(`FICTA_PII_ENABLED`), while launched coding agents keep PII detection off unless both `[pii] enabled`
and `[pii] agents` (`FICTA_PII_AGENTS`) are true, or unless `FICTA_PII_ENABLED` is explicitly set for
that one run.

### What it does not protect

ficta does not claim full prompt privacy, complete PII discovery, or full DLP coverage. Out of scope:
unregistered or transformed values (base64/URL-encoded/split secrets), PII the detector misses,
secrets or documents the agent sends itself through tool execution / `curl` / MCP tools, binary
responses, and arbitrary non-model network egress. See the
[threat model](packages/ficta/docs/threat-model.md) for the full boundary.

## Supported agents

| Agent | Status | Notes |
| --- | --- | --- |
| Claude Code | Verified | Uses Anthropic base URL routing. |
| Codex | Verified | Supports API-key and ChatGPT/OAuth flows. |
| Pi | Verified | Routes built-in `anthropic`/`openai`/`openai-codex` providers via an ephemeral `PI_CODING_AGENT_DIR` + `models.json` base-URL override. |

ficta only supports CLI agents that route **all** of their model traffic through its proxy. **IDE
clients such as Cursor are not supported** — their agentic features bypass a custom base URL, so
secrets could reach the provider unredacted. See the
[threat model](packages/ficta/docs/threat-model.md#ide-clients-cursor-etc).

## What's in this repo

This is a monorepo. The published package is the `ficta` CLI/proxy; the web app is the internal
PII-aware chat surface that exercises the same proxy.

- **[`packages/ficta`](packages/ficta)** — [`@steflsd/ficta`](https://www.npmjs.com/package/@steflsd/ficta),
  the CLI, redaction proxy, registry sources, agent integrations, and PII detector backends. This is
  the product published to npm.
- **[`apps/web`](apps/web)** — a private TanStack Start chat UI that routes every model call through
  the ficta proxy so registered secrets and best-effort detected PII are tokenized before the vendor
  and restored on the way back. Includes server-side BYO OpenAI/Anthropic keys, chat history/settings
  storage, optional WorkOS auth/workspaces, protection-status polling, and text-file attachments.

## Documentation

- [`packages/ficta/README.md`](packages/ficta/README.md) — full CLI/proxy install, usage, and commands
- [`apps/web/README.md`](apps/web/README.md) — internal web chat setup and environment
- [`docs/install.md`](packages/ficta/docs/install.md) — shim installation and runtime behavior
- [`docs/threat-model.md`](packages/ficta/docs/threat-model.md) — exact promise, covered surfaces, and non-goals
- [`docs/plugins.md`](packages/ficta/docs/plugins.md) — registry-source, detector, and agent-integration plugins
- [`docs/plugins.md#built-in-detector-plugin-pii`](packages/ficta/docs/plugins.md#built-in-detector-plugin-pii) — PII detector surfaces, backends, and failure policy
- [`docs/pii-gateway-north-star.md`](packages/ficta/docs/pii-gateway-north-star.md) — PII gateway architecture and north-star notes
- [`docs/exfil-and-egress.md`](packages/ficta/docs/exfil-and-egress.md) — why tool-channel egress is out of scope
- [`docs/codex-oauth-intercept.md`](packages/ficta/docs/codex-oauth-intercept.md) — Codex ChatGPT/OAuth routing
- [`docs/benchmarks.md`](packages/ficta/docs/benchmarks.md) — performance notes
- [`CONTRIBUTING.md`](packages/ficta/CONTRIBUTING.md) — contributing to core and extension seams
- [`SECURITY.md`](packages/ficta/SECURITY.md) — reporting vulnerabilities and expected limitations

## Status

ficta is pre-1.0 beta software. The core exact-match redaction, restore, and fail-closed behavior is
covered by tests and local agent runs, but early CLI users should run `ficta doctor <agent>` before
relying on it. The web UI is an internal PII-gateway pilot surface; run live checks with fake PII and
your own provider key before using it for sensitive workflows.

## Development

```sh
pnpm install
pnpm dev         # proxy + web; auto-uses Doppler when configured, otherwise local .env
pnpm dev:proxy   # proxy only
pnpm web:dev     # web UI only
pnpm check       # biome
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` is for developing the proxy + web UI together. The coding agents don't use it — `ficta
claude|codex|pi` starts its own ephemeral proxy per launch (see
[`docs/install.md`](packages/ficta/docs/install.md)).

## License

MIT — see [`LICENSE`](packages/ficta/LICENSE).
