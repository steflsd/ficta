# ficta — Decision Log

*Lightweight ADRs. Newest decisions appended. Captures scoping calls made during design so they
don't get re-litigated. As of 2026-06-21.*

## D1 — Threat model is provider-only

**Decision:** ficta's job is to keep secrets from **the model provider** — request logs, training,
and the append-only context window that re-sends them every turn (cf. Claude Code #29434). It is
**not** trying to stop a third-party service the agent calls from receiving/using a key, nor to
stop the agent exfiltrating data.

**Why:** that's the actual concern. Keeps the scope honest and small.

**Implications:** the curl/exfil tool-channel work is a non-goal (see D4); the security boundary
is the request side + the fail-closed gate, with the covered-surface caveats below.

## D2 — Restore happens in the API response (architecture "a")

**Decision:** ficta is a **pure proxy**. It redacts secrets → surrogates on the request, and
**restores real values in the API response** (text + tool-call args, incl. streaming). No
execution-time hook.

**Why:** provider-agnostic — works for Claude Code, Codex, and any base-URL-overridable client.
The alternative (b) (keep placeholders in the response + a `PreToolUse` hook that restores at
execution time) is cleaner — the transcript never holds real values — but ties us to Claude
Code's hook system. Chose generality.

**Implications (critical):**
- The client transcript stores **real** values, so they are **re-sent upstream every turn**.
- Therefore ficta must **re-scan and re-redact every request, deterministically**, and the
  **outbound fail-closed gate runs on every request body, query string, and non-auth header** as the backstop.
  Required provider auth headers pass through by design.
- **Detection consistency across turns > detection breadth.** A hit-then-miss across turns leaks
  into provider history.
- Restore is a **correctness** feature (don't corrupt files / keep the agent working), **not** a
  security feature — the provider is never in the restore path. See D5.
- Filesystem-path-like tokens are skipped by default to keep local agent tool calls usable. See D6.

## D3 — Current surrogates are deterministic opaque HMAC tokens

**Decision:** shipped placeholders are deterministic `FICTA_` + 32 hex chars derived from
`HMAC(local key, value)`. They are JSON-safe and stable within a proxy run; set
`FICTA_SURROGATE_KEY` to a high-entropy secret only if cross-restart stability is needed.

**Why:** this keeps the security-critical path small and auditable. The older
format-preserving/self-checksummed surrogate design remains an aspirational reliability idea in
[`restore-failure-model.md`](./restore-failure-model.md), not a shipped guarantee.

## D4 — Tool-execution exfil channel is a non-goal

**Decision:** sink-aware restore, host allowlists, and egress control are **out of scope** unless
the threat model changes. See [`exfil-and-egress.md`](./exfil-and-egress.md) (retained as boundary documentation).

**Why:** follows from D1. A redaction proxy is not a sandbox; that channel is owned by OS/container
egress control + agent permissions.

## D5 — Restore is correctness, not security

**Decision:** treat the response-side restore as a "don't break the user's files / keep the agent
working" feature, not a privacy guarantee.

**Why:** the provider isn't in the restore path. This reframes the step-5 reliability bar: it must
be good enough to not corrupt files, and the fail-closed gate (D2) — not restore — is what
protects the provider.

## D6 — Preserve filesystem paths by default

**Decision:** by default, do not redact registered values when the occurrence is inside a
filesystem-path-like token. Enable `FICTA_REDACT_PATHS=1` to opt back into path redaction.

**Why:** coding agents need literal local paths for `cd`, `Read`, `Edit`, and similar tool calls.
Public config values such as regions/profile names can appear in repo directory names; replacing
those substrings produces unusable `FICTA_...` paths.

**Implications:** do not put real secrets in path names if using the default. The fail-closed gate
uses the same path-aware matching so it does not block just because a skipped path contains a
registered value.

## D7 — Public positioning stays secrets-first and scoped

**Decision:** publish ficta as a beta OSS developer tool for individual coding-agent users, not as
enterprise DLP, a compliance product, or a general LLM security platform.

**Why:** the reliable shipped promise is exact-match protection for registered values in covered
model-request surfaces. Leading with broader DLP/PII/security claims would create false confidence
and attract the wrong evaluation criteria.

**Implications:** docs and launch copy should:

- lead with `.env`, process-env, and Doppler secrets;
- describe PII/detector support as best-effort and secondary;
- avoid blanket phrases like "secure", "never leaks", or "full DLP" unless immediately scoped;
- avoid broad Product Hunt-style launch language until the agentic restore path has more field use;
- point readers to [`threat-model.md`](./threat-model.md) and [`publishing.md`](./publishing.md).
