# Live end-to-end protection check

This suite is the one test that proves ficta's core claim against the **real**
runtime: it launches each real agent binary (`claude`, `codex`, `pi`) through the
real ficta CLI, against the real provider using **your own auth**, makes the agent
read a sample `.env` containing a canary, and asserts ficta stripped that canary
from what it forwarded upstream.

It is **opt-in** and never runs in `pnpm test` / `pnpm verify` / CI — it needs the
agent binaries, live auth, and spends real tokens.

## Run it

```sh
pnpm test:e2e          # just the live suite
pnpm verify:live       # offline verify, then the live suite (local release gate)
```

Each agent **self-skips** with a printed reason when its real binary or auth is
absent, so a partial setup still produces honest output (never a false green).

## Prerequisites

- The real agent binaries installed and on `PATH` (resolved excluding the
  `~/.ficta/bin` shim; override with `FICTA_REAL_CLAUDE` / `FICTA_REAL_CODEX` /
  `FICTA_REAL_PI`).
- Provider auth for whichever agents you want to exercise:
  - **claude** — `~/.claude` (subscription) or `ANTHROPIC_API_KEY`
  - **codex** — `~/.codex/auth.json` or `OPENAI_API_KEY`
  - **pi** — uses Pi's own stored logins (`~/.pi/agent/auth.json`) and its real default
    provider from `~/.pi/agent/settings.json` (typically `openai-codex`). Override with
    `FICTA_E2E_PI_PROVIDER` / `FICTA_E2E_PI_MODEL`. Only the built-in
    `anthropic`/`openai`/`openai-codex` providers are routed through ficta.

Optional overrides:
- `FICTA_E2E_CLAUDE_MODEL`, `FICTA_E2E_CODEX_MODEL` — pin a model.
- `FICTA_E2E_ONLY=claude,codex` — run only the named agents (cheaper targeted runs).
- `FICTA_E2E_REGISTRY_OVERRIDE=<path>` — point the registry elsewhere (negative control).
- `FICTA_REAL_CLAUDE` / `FICTA_REAL_CODEX` / `FICTA_REAL_PI` — pin the real binary path.

## What each run asserts

Against ficta's own egress capture (`FICTA_LOG_LEVEL=trace` → `run-*/req-*.sent.json`,
the exact bytes forwarded upstream):

1. **Pre-redaction body contains the canary** — proves the agent actually pulled it
   into the request (guards against a false pass where the agent never read the file).
2. **No forwarded body contains the canary** — the core guarantee: nothing leaked.
3. **A `FICTA_…` placeholder is present** — positive proof the value was redacted,
   not merely absent.
4. *(soft)* the agent's stdout contains the restored canary — confirms the local
   restore round-trip. Warns instead of failing, since model phrasing varies.

## Negative control (prove the test can fail)

The assertions only mean something if the suite actually fails when protection is
off. Confirm it on one agent with the canary **unregistered**:

```sh
FICTA_E2E_ONLY=claude FICTA_E2E_REGISTRY_OVERRIDE=/dev/null pnpm test:e2e
```

ficta now has nothing to redact, so it forwards the agent's request verbatim and
writes no redacted body — the run produces **no redaction evidence**, and the suite
**FAILS** (no forwarded `.sent.json` / no `FICTA_…` placeholder). A green run here
would mean the assertions are vacuous; a red run confirms they depend on real
protection. (ficta only logs bodies it actually redacted, so the unprotected canary
shows up as absence-of-evidence rather than a captured leak.)
