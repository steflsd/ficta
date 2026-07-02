# Security policy

ficta is a local privacy guardrail for AI coding-agent model traffic. Its scoped security boundary
is described in [`docs/threat-model.md`](./docs/threat-model.md): registered values, verbatim form, covered
request surfaces. This is not a general security certification, enterprise DLP claim, or compliance
claim.

## Supported versions

This project is pre-1.0. Until a stable release exists, only the current main branch / latest published package, if any, should be considered supported.

## Independent review

We recommend cloning this repository and asking your own coding or security agent to audit the code before use. In particular, ask it to verify whether the app contains any exfiltration paths or malicious behavior. Use fake fixture secrets during review; do not provide real API keys, tokens, `.env` files, or provider transcripts to the agent.

## Reporting a vulnerability

If you find a vulnerability or a case where ficta forwards a registered value verbatim in a covered request surface, please report it privately rather than opening a public issue with secret material.

When reporting, include:

- ficta version or commit;
- agent/client used (`claude`, `codex`, `pi`, etc.);
- relevant ficta config flags, especially registry settings, `FICTA_REDACT_PATHS`, and process-env loading;
- a minimal reproduction using fake fixture values; and
- whether raw body logging was enabled.

Do **not** include real API keys, tokens, Doppler output, `.env` files, request logs, or provider transcripts.

## Language scope

Use "security" in this project only with the scoped boundary above. Avoid blanket claims such as
"secure your agents" or "never leaks secrets" unless immediately qualified by the exact-match,
covered-surface threat model.

## Out of scope

The following are expected limitations, not vulnerabilities by themselves:

- transformed values that were not registered in transformed form;
- real secrets embedded in filesystem paths while `FICTA_REDACT_PATHS=0`;
- provider auth headers passing through to the provider;
- agent tool-execution exfiltration such as `curl`, `scp`, MCP tools, or custom scripts;
- secrets sent outside the proxied model API channel; and
- unregistered secrets not detected by any enabled detector.

## Logs and diagnostics

`FICTA_LOG_LEVEL=trace` can write raw request/response bodies for debugging. Those logs may contain real secrets and should not be shared publicly. It is runtime-only (never persisted to `config.toml`); keep the level at `info` or below for normal use.
