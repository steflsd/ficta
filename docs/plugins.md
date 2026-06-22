# Plugins and registry-source discovery

ficta separates the privacy-critical core from the places values come from.

The core invariant is:

> Plugins may only **report values or detections**. The core engine/vault performs replacement,
> fail-closed leak checks, and restore.

That lets us add sources like Doppler/1Password or detectors like Gitleaks without letting plugin
code bypass the redaction boundary.

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

The TypeScript shape is intentionally small:

```ts
interface FictaPlugin {
  name: string;
  description?: string;

  // Safe launch-time status. Counts/paths/instructions only; never values.
  discover?(): readonly PluginDiscovery[];

  // Exact registered values loaded at startup.
  loadValues?(): readonly ProtectedValue[];

  // Optional request-time detector values.
  detectText?(text: string, ctx: DetectTextContext): readonly ProtectedValue[];

  // Optional agent/client launch adapters.
  agents?: readonly AgentIntegration[];
}
```

`ProtectedValue.value` is the protected literal and must never be logged. `PluginDiscovery` is the
safe thing the CLI may print. `AgentIntegration` returns a launch plan; the CLI still owns shim
resolution, proxy lifecycle, and cleanup.

## Launch-time discovery UX

`ficta claude` / `ficta codex` / `ficta pi` starts by building a registry snapshot:

```txt
registry sources:
  ✓ Doppler CLI (31 values) — loaded via `doppler secrets download --no-file --format json` before launching the agent
  ✓ env files (12 values) — read 2 file(s)
      .env: 8 loaded
      .env.local: 4 loaded
  ✓ process env (31 values) — auto-enabled because doppler was detected
  ✓ Doppler env (31 values) — detected; secret-ish process env loaded automatically
```

If nothing is loaded, the source report explains what was tried:

```txt
registry sources:
  - env files (0 values) — looked for .env:.env.local
      .env: not found
      .env.local: not found
  - Doppler CLI (0 values) — no Doppler secrets loaded; configure Doppler or set FICTA_REGISTRY_DOPPLER_ENABLED=0 to skip
  ! process env (0 values) — 5 secret-ish env var name(s) detected; enable with FICTA_REGISTRY_PROCESS_ENV_ENABLED=1
```

This replaces the old “turn on raw body logs and inspect JSON” trust step. Raw body logs remain an
explicit debugging opt-in only.

## Built-in registry source: `doppler-cli`

The Doppler CLI plugin runs before the agent launches and attempts to load exact values with:

```sh
doppler secrets download --no-file --format json --no-fallback --silent
```

Default:

```sh
FICTA_REGISTRY_DOPPLER_ENABLED=1
```

Disable it with:

```sh
FICTA_REGISTRY_DOPPLER_ENABLED=0 ficta claude
```

By default only Doppler's active config for the current repo/scope is loaded. To cover agents that
may call other configs, set:

```sh
FICTA_REGISTRY_DOPPLER_CONFIGS=dev,staging,prod ficta claude
FICTA_REGISTRY_DOPPLER_CONFIGS=all ficta claude
FICTA_REGISTRY_DOPPLER_PROJECT=my-project ficta claude  # optional explicit project
```

The command output is parsed in memory, filtered by `FICTA_REGISTRY_MIN_LEN`, and never printed.
Discovery output contains only counts/status/config names. The startup timeout defaults to 5 seconds
and can be changed with `FICTA_REGISTRY_DOPPLER_TIMEOUT_MS`.

This is the source that protects values if the agent later runs `doppler ...`: the secrets are
already registered before the model session starts. Loading `all` configs is explicit so a dev
session does not silently pull prod secrets into RAM unless you ask for that coverage.

## Built-in registry source: `known-env-values`

This plugin exposes two discovered sources:

### Env files

Default:

```sh
FICTA_REGISTRY_ENV_FILE_ENABLED=1
FICTA_REGISTRY_ENV_FILE_PATHS=.env:.env.local
```

Use colon-separated paths for extra files, or disable the source:

```sh
FICTA_REGISTRY_ENV_FILE_PATHS=.env:.env.production:config/secrets.env ficta claude
FICTA_REGISTRY_ENV_FILE_ENABLED=0 ficta claude
```

### Process env

By default, the wrapper loads process-env values whose names look secret-ish. This protects common
agent behavior like running `env` or printing tool output that includes inherited API keys. Disable
it only if the extra exact-match values cause unacceptable false positives:

```sh
FICTA_REGISTRY_PROCESS_ENV_ENABLED=1 ficta claude        # default for wrapper/setup
FICTA_REGISTRY_PROCESS_ENV_MODE=secret-ish ficta claude  # secret-ish names only
FICTA_REGISTRY_PROCESS_ENV_MODE=all ficta claude         # every env var value
FICTA_REGISTRY_PROCESS_ENV_ENABLED=0 ficta claude        # disabled
```

Secret-ish names are matched by a conservative name filter such as `KEY`, `TOKEN`, `SECRET`,
`PASSWORD`, `JWT`, `DATABASE`, `OPENAI`, `ANTHROPIC`, `AWS`, `GITHUB`, and similar. Proxy-internal
values that child agents do not need, such as `FICTA_SURROGATE_KEY`, are not passed to the child
agent process.

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
