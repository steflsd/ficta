# Plugins and registry-source discovery

ficta separates the privacy-critical core from the places values come from.

The core invariant is:

> Plugins may own source-specific **config/setup metadata**, but at runtime they only **report
> values or detections**. The core engine/vault performs replacement, fail-closed leak checks, and restore.

That lets us add sources like Doppler/1Password or detectors like Gitleaks without letting plugin
code bypass the redaction boundary.

## Terminology

- **Plugin** — the umbrella term for a narrow extension point inside ficta. A plugin must explicitly
  declare a capability boundary; registry hooks are valid only on `kind: "registry-source"` plugins
  that also own their source-specific metadata.
- **Registry-source plugin** — loads exact protected values at launch, such as `.env`, process env,
  Doppler, or a future secret-manager source. This is the strongest exact-match layer.
- **Detector plugin** — inspects request text at runtime and reports values to protect. A PII
  integration should be described as a **PII detector plugin**. Detector coverage is best effort and
  secondary to registry-source exact matching.
- **Agent-integration plugin** — teaches ficta how to launch a coding agent through the local proxy,
  such as Claude Code, Codex, or Pi.
- **Provider adapter** — provider/wire-format routing and restore support. This is core-owned for
  now; new provider support should be discussed before a large PR.
- **Addon** — a future packaging term for optional external code that may contain one or more
  plugins. ficta does not yet have a stable external addon API or automatic third-party plugin
  loading.

## Plugin types

Today a plugin can provide any of these capabilities:

1. **Registry source** — launch-time exact values. This is the exact-match layer: if a value is loaded
   here, ficta exact-matches it and fail-closes if it would reach the model verbatim in a covered
   request surface. Filesystem-path-like tokens are skipped by default; set `FICTA_REDACT_PATHS=1`
   to redact inside paths too.
2. **Detector** — request-time detections. This is the best-effort layer for unknown/pasted secrets
   or optional PII-like patterns; it is not the primary product promise.
3. **Agent integration** — how to launch a client through the ephemeral ficta proxy (`claude`,
   `codex`, `pi`, later `opencode`, etc.).

The TypeScript shape makes the registry boundary explicit:

```ts
type FictaPlugin = RegistrySourcePlugin | DetectorPlugin | AgentIntegrationPlugin;

interface RegistrySourcePlugin {
  kind: "registry-source";
  name: string;

  // Required: each registry source owns its TOML/env/default metadata and setup UX.
  config: RegistryPluginConfig;
  setup: RegistryPluginSetup;

  // Required: values and safe status only; never print protected values.
  discover(): readonly PluginDiscovery[];
  loadValues(): readonly ProtectedValue[];
}
```

A plugin that defines registry hooks (`loadValues`, `discover`, `config`, or `setup`) without
`kind: "registry-source"` and the required registry metadata fails validation. `ProtectedValue.value`
is the protected literal and must never be logged. `PluginDiscovery` is the safe thing the CLI may
print. Built-in `RegistryPluginConfig` / `RegistryPluginSetup` metadata lets each registry source
own its TOML/env bindings and setup prompts. `AgentIntegration` returns a launch plan; the CLI still
owns shim resolution, proxy lifecycle, and cleanup.

## Launch-time discovery UX

`ficta claude` / `ficta codex` / `ficta pi` starts by building a registry snapshot, but the default
startup output stays compact:

```txt
🔒 ficta ready — 47 protected values (48 loaded before dedupe)
   pi → http://127.0.0.1:59717
   sources: Doppler 34, .env.local 4, process env 10
```

Set `FICTA_VERBOSE=1` or pass `--ficta-verbose` after the agent command for the full safe discovery
report:

```txt
source details:
  ✓ Doppler CLI (34 values) — loaded current config via `doppler secrets download --no-file --format json`; skipped 4 shorter than 8 chars
      current: 34 loaded
  ✓ env files (4 values) — read 1 file(s)
      .env: not found
      .env.local: 4 loaded
  ✓ process env (10 values) — enabled for secret-ish env names; skipped 4 shorter than 8 chars, 3 empty
```

If nothing is loaded, the compact summary says so and the existing passthrough/strict-mode warning
explains what happens next. Run `ficta doctor` when you want the full source report without
launching an agent.

The source report is safe to print: counts + file/source names only, never values. Raw body logs
remain an explicit debugging opt-in only.

## Configuring built-in plugins

Persistent user config lives in `~/.ficta/config.toml` (written by `ficta setup`). Shell
`FICTA_*` environment variables still override the TOML for a single run, but normal plugin/source
configuration should live in TOML:

```toml
[registry]
min_len = 8
require = false

[registry.env_file]
enabled = true
paths = [".env", ".env.local"]

[registry.process_env]
enabled = true
mode = "secret-ish"

[registry.doppler]
enabled = true
configs = "current" # or "all" / ["dev", "staging", "prod"]
project = ""
# command = "doppler"
timeout_ms = 5000
```

Set `FICTA_CONFIG_FILE=/path/to/config.toml` to use a different config file; `ficta setup` writes
to that same path. Set `FICTA_CONFIG_FILE=0` to disable user config loading; setup will then refuse
to run until you unset it or provide a real path.

## Built-in registry source: `doppler-cli`

The Doppler CLI plugin runs before the agent launches and attempts to load exact values with:

```sh
doppler secrets download --no-file --format json --no-fallback --silent
```

Default TOML:

```toml
[registry.doppler]
enabled = true
configs = "current"
```

Disable it with:

```toml
[registry.doppler]
enabled = false
```

By default only Doppler's active config for the current repo/scope is loaded. To cover agents that
may call other configs, set:

```toml
[registry.doppler]
configs = ["dev", "staging", "prod"]
# or:
# configs = "all"
project = "my-project" # optional explicit project
```

The command output is parsed in memory, filtered by `registry.min_len`, and never printed.
Discovery output contains only counts/status/config names. The startup timeout defaults to 5 seconds
and can be changed with `registry.doppler.timeout_ms`.

`registry.doppler.command` / `FICTA_REGISTRY_DOPPLER_COMMAND` is trusted local config: ficta
executes that command directly (without a shell), refuses project-local or world-writable resolved
commands, and passes a minimal Doppler/HOME/proxy environment so the real Doppler CLI can
authenticate. Only point it at a trusted executable you control; do not accept this setting from
untrusted project files or shell snippets.

This is the source that protects values if the agent later runs `doppler ...`: the secrets are
already registered before the model session starts. Loading `all` configs is explicit so a dev
session does not silently pull prod secrets into RAM unless you ask for that coverage.

## Built-in registry source: `known-env-values`

This plugin exposes two discovered sources:

### Env files

Default TOML:

```toml
[registry.env_file]
enabled = true
paths = [".env", ".env.local"]
```

Add extra files, or disable the source:

```toml
[registry.env_file]
enabled = true
paths = [".env", ".env.production", "config/secrets.env"]

# or:
# enabled = false
```

### Process env

By default, the wrapper loads process-env values whose names look secret-ish. This protects common
agent behavior like running `env` or printing tool output that includes inherited API keys. Disable
it only if the extra exact-match values cause unacceptable false positives:

```toml
[registry.process_env]
enabled = true
mode = "secret-ish" # or "all"

# or:
# enabled = false
```

Secret-ish names are matched by a conservative name filter such as `KEY`, `TOKEN`, `SECRET`,
`PASSWORD`, `JWT`, `DATABASE`, `OPENAI`, `ANTHROPIC`, `AWS`, `GITHUB`, and similar. Proxy-internal
values that child agents do not need, such as `FICTA_SURROGATE_KEY`, are not passed to the child
agent process.

## Candidate registry sources (not built yet)

These are plausible future `loadValues()` sources that fit the same launch-time exact-match
contract as `doppler-cli`. Listed as candidates only — none ship today.

- **`varlock`** — load exact values from a [varlock](https://varlock.dev/) project so its
  `@sensitive` schema values are protected on the wire. varlock's own boundary is keeping
  secrets out of *files* the agent reads; a ficta source would extend that to *covered model
  requests*, the same shape as Doppler. Likely implemented by resolving values at launch (e.g.
  `varlock load --format json` or reading the resolved `@sensitive` keys) and returning them as
  `ProtectedValue`s. See [`competitors.md`](./competitors.md) Category F for the boundary split.

Anyone adding one should keep it launch-time, timeout the external call, and never print values —
same rules as the built-in sources.

## Optional detector plugins

Detector plugins run during request redaction. They are useful for high-confidence unknown secrets
or PII-like values, but they are best-effort and should not be the headline claim:

```ts
const emailDetector: FictaPlugin = {
  name: "email-detector",
  detectText(text) {
    return [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])].map((value) => ({
      name: "EMAIL",
      value,
      source: "email-detector",
      kind: "pii",
      confidence: "high",
    }));
  },
};
```

Detector output enters the same vault as registry values, but the protection claim is different:

- registry exact values: **covered by the exact-match fail-closed invariant in covered request surfaces**
- detector values: **best effort, depending on detector coverage/precision**

## Built-in agent integrations

The `builtin-agent-integrations` plugin currently provides:

- `claude` — launches the real Claude Code executable with `ANTHROPIC_BASE_URL=<ficta>`.
- `codex` — launches the real Codex executable with temporary `-c` provider overrides; detects
  ChatGPT/OAuth auth and adds `requires_openai_auth` + `chatgpt_base_url` when needed.
- `pi` — writes a temporary Pi extension and launches `pi -e <extension> ...`. The extension calls
  `pi.registerProvider("anthropic", { baseUrl: <ficta>/v1 })` and
  `pi.registerProvider("openai", { baseUrl: <ficta>/v1 })` so Pi's Anthropic/OpenAI built-in
  models/auth are preserved while model traffic passes through ficta. Other Pi providers need their
  own adapter/wire support before they are covered.

Shim installation is derived from the registered agent integrations, not a hardcoded command list.

## Safety rules for plugins

- Never log or print `ProtectedValue.value`.
- `discover()` output must be safe metadata only.
- Keep secret-manager calls launch-time; request-time plugins should be local and fast.
- Use timeouts for external CLI integrations.
- The request path should only add values/detections; the core remains responsible for redaction,
  leak counting, and restore.

External/community plugins should be explicit opt-in later. Built-ins are trusted and loaded by
default.
