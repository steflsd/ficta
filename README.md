# ficta

**Keep the secrets you already manage (`.env` / Doppler) out of the LLM — automatically, locally,
without breaking your coding agent — with a fail-closed check for the values ficta protects.**

ficta is a small local proxy between your coding agent and the model provider. On the way **up** it
replaces your registered secret values with deterministic surrogates (the model never sees them);
on the way **back** it restores the real values locally (your agent still edits real files and runs
real commands). If a protected value would slip through in a covered request surface, it **refuses
to send** rather than leak.

## Who it's for

Individual devs using coding agents — **Claude Code, Codex, and Pi**, including
ChatGPT-subscription / OAuth Codex — who don't want real keys landing in a provider's request logs,
training data, or the append-only context window. Especially people on **subscription auth**, who
today have no secret-hygiene option. It's a personal hygiene / peace-of-mind tool, not enterprise
DLP or a compliance product.

## Why this exists

This started from a recurring annoyance: an agent would read a real key into context, then
helpfully say some version of "you should rotate that now." Rotating is the right advice after a
leak, but the better workflow is to avoid putting the secret in the model session in the first
place. ficta is that local airlock: let the agent keep working with files and commands, while the
provider sees deterministic placeholders for the registered values.

## Requirements

- Node.js 20+
- pnpm 11+ via Corepack or a local install
- one of the supported coding-agent CLIs: `claude`, `codex`, or `pi`
- optional: Doppler CLI, if you want ficta to load Doppler-managed secrets at launch

## Quick start

Install once from this checkout, then keep using your normal agent commands:

```sh
git clone https://github.com/steflsd/ficta.git
cd ficta
pnpm install
pnpm ficta setup            # configure ~/.ficta/config.env; optionally installs shims
# or: pnpm ficta install    # installs ~/.ficta/bin/{ficta,claude,codex,pi} shims directly
# restart your shell
claude                      # actually runs through ficta
codex
pi

# Doppler CLI secrets are loaded into ficta's registry before the agent starts:
claude
# Running under Doppler also works:
doppler run -- claude
```

The shims start an ephemeral proxy on a random loopback port, discover registry sources in the
current project/env, launch the real agent through ficta, and shut down when the agent exits. If no
protected values load, ficta warns and launches in passthrough mode by default; set
`FICTA_REQUIRE_REGISTRY=1` if you want strict startup blocking. Non-model commands like
`--version`/`--help` pass through directly.

No shim install / dev mode:

```sh
pnpm ficta claude           # or: pnpm ficta codex / pnpm ficta pi
```

The wrapper auto-detects Codex's ChatGPT/OAuth vs API-key auth and configures routing for you;
it runs the proxy silently so it never garbles the agent's terminal. Use `pnpm ficta doctor claude`
(or `codex` / `pi`) to sanity-check registry loading and routing without launching the agent.

Manual (no wrapper):
```sh
pnpm dev                                          # proxy on :8787
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
# Codex: see ./docs/codex-oauth-intercept.md
```

**Registry = zero config.** At launch, built-in registry-source plugins discover `.env` files,
Doppler CLI secrets, Doppler-injected process env, and optional process-env sources. The startup
banner prints a safe source report (counts + file/source names only, never values), then the
fail-closed gate enforces that registered values do not leave verbatim.

## Exact-match protection model

- **Scope = your registered values in their verbatim form, in covered request surfaces** — the
  honest, provable boundary. ficta does *not* claim to catch every conceivable secret or
  transformed representation.
- **Provable for that scope:** exact-match redaction + a **fail-closed gate** that re-scans every
  outbound request body, query string, and non-auth header and blocks on any leak it is expected to redact.
  Required provider auth headers (`Authorization`, `x-api-key`, cookies) pass through because the
  upstream needs them. Filesystem-path-like tokens are intentionally left unredacted by default so
  agents don't break local `cd`/`read`/`edit` tool calls; set `FICTA_REDACT_PATHS=1` if your threat
  model requires redacting secrets embedded in path names. Keyed deterministic surrogates mean the
  same value maps to the same token within the local proxy run, so resent conversation history stays
  clean every turn.
- **Restore is local-only** — the provider is never in the restore path.
- **Local, no telemetry, secrets stay in RAM.** Raw bodies are off by default; logs contain only
  hit **names + JSON paths**, never values.
- **Boundary (non-goals):** ficta is *not* a sandbox, enterprise DLP, or a compliance control — it
  doesn't stop the agent itself exfiltrating via `curl` (that's OS/egress territory; see
  [`docs/exfil-and-egress.md`](./docs/exfil-and-egress.md)), and unregistered/transformed values get only best-effort coverage,
  not the exact-match guarantee.

## Plugin architecture

ficta has a narrow plugin seam around a small, well-tested core:

- **Registry-source plugins** discover and load exact values at launch (`.env`, process env,
  Doppler). This is the covered exact-match layer.
- **Detector plugins** can add request-time values later (Gitleaks-style secrets or PII-like
  patterns). This is a best-effort layer, not the headline promise.
- **Agent-integration plugins** know how to launch a client through ficta (`claude`, `codex`, `pi`).
- The **core vault/engine owns replacement, fail-closed leak checks, and restore**. Plugins return
  values/detections/launch plans; they do not forward traffic or perform redaction themselves.

See [`docs/plugins.md`](./docs/plugins.md) for the plugin/source contract and launch discovery UX.

## What makes it different

ficta is not a new cryptographic primitive; the pieces exist elsewhere. What it combines that others don't:
1. Works for coding agents on **subscription/OAuth auth** (Codex-ChatGPT, Claude Pro) — most
   privacy tools assume API keys.
2. A **provable, fail-closed exact-match check for known secrets in covered request surfaces** — vs probabilistic PII detection.
3. **Reversible round-trip through streaming tool-calls** so the agent keeps working.
4. **Zero-config local install.**

See [`docs/competitors.md`](./docs/competitors.md) for the full landscape and
[`docs/publishing.md`](./docs/publishing.md) for public-positioning guardrails.

## Status

Working and verified: redaction + restore + fail-closed gate across Claude (Messages) and Codex
(OpenAI chat / Responses / ChatGPT-OAuth backend). Covered by `pnpm test` and live local
`claude -p` / `codex` runs with registered fixture values. Overhead ~2–3 ms/request (<1% vs model
latency) — see [`docs/benchmarks.md`](./docs/benchmarks.md).

The `ficta claude` / `ficta codex` / `ficta pi` wrappers use agent-integration plugins. Claude and
Codex are verified against real sessions; Pi uses a temporary extension to override Anthropic/OpenAI
provider base URLs and should work for those providers.

## Planned

These are roadmap items, not part of the current exact-match guarantee:

- **PII anonymization + restore plugins** for values such as emails, phone numbers, names, orgs, or
  custom patterns. These will be best-effort detector/anonymizer plugins unless values are explicitly
  registered.
- **Longer-lived local sessions** so surrogate mappings can optionally survive beyond one agent run.
  Today, registry values and mappings are in memory for the current agent/proxy session only, with a
  stable local surrogate key used to keep placeholders deterministic.
- **More agent/provider adapters** as their routing hooks become clear.

## Config

Run `ficta setup` for persistent user config. It writes `~/.ficta/config.env`, but only stores
choices that differ from the built-in defaults plus the optional local surrogate key. Environment
variables still work as one-off overrides, but normal use should not require exporting a pile of
`FICTA_*` values.

Built-in defaults:

- load `.env:.env.local`
- load Doppler's current config when the Doppler CLI is available
- load secret-ish process-env values (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AWS`, etc.)
- fail closed when a protected value survives redaction
- keep raw body logs off
- preserve filesystem paths by default (`FICTA_REDACT_PATHS=0`)
- write safe metadata logs under `~/.ficta/logs`

Useful one-off overrides:

```sh
FICTA_REQUIRE_REGISTRY=1 claude          # refuse to launch if no protected values load
FICTA_REDACT_PATHS=1 claude              # redact inside filesystem-path-like tokens too
FICTA_LOG_BODIES=1 claude                # debug only: writes raw request/response bodies
FICTA_REGISTRY_DOPPLER_CONFIGS=dev,prod claude
FICTA_REGISTRY_ENV_FILE_PATHS=.env:.env.production claude
FICTA_DISABLE=1 claude                   # bypass an installed shim once
```

Advanced/diagnostic overrides still exist for ports, upstreams, timeouts, and source toggles; see
`.env.example` and [`docs/plugins.md`](./docs/plugins.md) for details.

> ⚠️ Set `FICTA_LOG_BODIES=1` only for debugging: raw body logs may contain real secrets. Leave it
> unset/`0` for normal use.

## Commands

```sh
pnpm ficta setup        # interactively configure ~/.ficta/config.env, optionally install shims
pnpm ficta doctor       # check registry loading, safety config, and agent routing
pnpm ficta install      # install transparent claude/codex/pi shims
pnpm ficta uninstall    # remove shims
pnpm ficta claude       # run through ficta without installing shims
pnpm dev                # run the proxy manually on :8787
pnpm test               # vitest fundamentals
pnpm bench              # vault microbenchmark
pnpm bench:e2e          # end-to-end latency vs direct
pnpm typecheck
```

## Docs

- [`docs/threat-model.md`](./docs/threat-model.md) — precise promise, covered surfaces, and non-goals
- [`SECURITY.md`](./SECURITY.md) — scoped vulnerability reporting and expected limitations
- [`docs/architecture-plan.md`](./docs/architecture-plan.md) — historical architecture notes / aspirational phase-2 detail
- [`docs/install.md`](./docs/install.md) — installing transparent `claude`/`codex`/`pi` shims
- [`docs/plugins.md`](./docs/plugins.md) — registry-source/detector plugin architecture
- [`docs/decisions.md`](./docs/decisions.md) — scoping decisions (D1–D7)
- [`docs/restore-failure-model.md`](./docs/restore-failure-model.md) — step-5 round-trip reliability
- [`docs/exfil-and-egress.md`](./docs/exfil-and-egress.md) — tool-channel exfil (non-goal) + boundary
- [`docs/codex-oauth-intercept.md`](./docs/codex-oauth-intercept.md) — routing Codex on ChatGPT/OAuth
- [`docs/benchmarks.md`](./docs/benchmarks.md) — performance
- [`docs/publishing.md`](./docs/publishing.md) — beta publishing/positioning guardrails
- [`docs/competitors.md`](./docs/competitors.md) — competitive landscape

## Limitations

- Protects **registered values in verbatim form** in covered request surfaces. Encoded,
  compressed, split, or otherwise transformed forms such as base64/URL-encoding are not guaranteed
  unless they are registered as their own values.
- Filesystem-path-like tokens are skipped by default to keep coding agents usable when public config
  values (for example regions or profile names) appear in directory names. Do not put real secrets
  in path names, or set `FICTA_REDACT_PATHS=1` to redact inside paths too.
- Required provider auth headers pass through by design; ficta redacts/gates request bodies, query
  strings, and non-auth headers. Custom non-auth headers containing registered values are sent upstream with
  surrogates and are not restored, which may break an upstream that expects that exact header.
- Response restore runs only for JSON/text/event-stream content; binary responses pass through
  untouched.
- Restore is exact-match surrogate replacement today; restoring values with quotes/newlines into a
  tool-call JSON arg can be imperfect (fine for typical alphanumeric keys/tokens).
- Not a sandbox (see non-goals above).

## License

MIT — see [`LICENSE`](./LICENSE).
