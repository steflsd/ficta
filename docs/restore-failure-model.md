# ficta — Restore Failure Model (step-5 round-trip)

*Design note / future reliability target. The shipped implementation currently uses exact-match
restore of opaque `FICTA_<32 hex>` surrogates only. Format-preserving surrogates, checksums,
normalize-match, round-trip integrity guards, and residual surrogate blocking described below are
not implemented guarantees yet.*

## The problem (step 5)

ficta swaps a secret `V` → a surrogate `S` on the way **up** (request side — easy). On the way
**down**, the model's `tool_use` args may contain `S`, and ficta must restore `V` **before the
client executes the tool locally** (writes the file, runs the bash command). Restore can only
act on what the model actually emits — so the failure vector is: *the model didn't emit `S`
cleanly.*

```
Read(".env") → client reads "API_KEY=sk-real-123"
  → UP:   tool_result "API_KEY=AKIAFCT7F3A9C2E1Q"      (swap OUT — easy)
  ← DOWN: Write(".env", "API_KEY=AKIAFCT7F3A9C2E1Q\n…") (swap IN  — HARD, this doc)
  → client writes real key; model never saw V
```

## Key reframe: the model never sees `V`

Because the model only ever holds the surrogate `S`, it **cannot author a correct transformed
literal of `V`** (it can't compute `base64(V)` or `V.upper()` as a constant — it never saw `V`).
So every model behavior falls into exactly three buckets:

| Bucket | What the model did | Recoverable? |
|---|---|---|
| **Transport mutation** | tried to reproduce `S`, garbled it (case, whitespace, dropped delimiters, split) | ✅ recognize garbled form → restore `V` verbatim |
| **Runtime transform** | wrote code/command that transforms at execution: `echo S \| base64`, `S.toUpperCase()` | ✅ **restore `V` verbatim**; the transform runs **locally on the real value** |
| **Drop** | replaced `S` with its own guess (`your-key-here`) or omitted it | ❌ irreducible — nothing to restore |

**Consequence:** we (almost) never transform `V` ourselves. For runtime transforms, locality
does the work — tool calls execute locally on the restored real value, so pre-applying the
transform would *double-apply* it. "Apply the same mutation to the original" therefore reduces
to: **invert the transport garbling to *locate* the surrogate, then restore `V` verbatim.**

This collapses the scary surface to two cases: transport (recoverable) and drop (detect, don't
silently ship).

## Future lever: format-preserving, self-checksummed surrogates

Mutation rate is driven by the surrogate *looking weird*. A Unicode sentinel like `«SECRET:1»`
invites the model to "fix" it. Instead, make `S` a deterministic fake that looks like the same
*kind* of value:

- AWS key `AKIA…` → `AKIA` + 16 deterministic base32 chars (still looks like an AWS key)
- generic secret → `fct1<base32(HMAC(key, V))[:16]><crc>` (a normal opaque token)
- email → `u7f3a@redacted.example`; IP → a syntactically valid IP

Why this is the highest-leverage decision:

- Models **copy normal-looking strings verbatim** far more reliably than Unicode sentinels →
  transport-mutation rate drops hard.
- Length/charset preserved → doesn't break JSON, regexes, quoting, or length-sensitive code.
- Restore becomes **exact-string replace** of `S` via the per-request map.
- **Checksum baked in** → ficta can (a) still find `S` after light fuzzing, and (b) **detect
  corruption**: a surrogate failing its checksum is a *known* unrestorable event, never a silent
  mis-restore.
- **Deterministic derivation** (HMAC with a per-install key) → same secret → same surrogate, so
  multi-turn echoes restore, and nothing about `V` leaks upstream (attacker without the local
  key can't brute-force; see threat model notes in [`architecture-plan.md`](./architecture-plan.md)).

Prior art: format-preserving tokenization / synthetic-surrogate redaction (Skyflow, Private AI).

## Target failure-handling stack (defense-in-depth; not fully shipped)

| Layer | What it does | Recovers | Nature |
|---|---|---|---|
| 1. Exact match | restore verbatim surrogate | verbatim | corrective, total |
| 2. Normalize-then-match | canonicalize case/whitespace/delimiters, then match | transport mutations | corrective, total (fixed normalizer) |
| 3. Checksum-recognize | find + validate self-describing surrogates in the stream | fuzzed transport | corrective; **detects corruption** |
| 4. Round-trip integrity guard | track which surrogates went *up* for file X; on the Write-back, assert they reappear | **drop / silent-wrong-value** | detective |
| 5. Fail-closed on residual | after restore, scan outbound tool args; any leftover surrogate-shaped or checksum-failed token → **block the tool call** | prevents writing broken/leaked values | **hard guarantee** |
| 6. Confirm / dry-run | for Write/Edit/Bash touching a known value where restore was non-exact, show a diff / require confirm | last-resort UX guard | human-gated |

**Current shipped stack:** layer `1` only: exact-string restore of intact surrogates.

**Target stack:** `1 → 2 → 3` for restore (covers all transport), `4 + 5` as the safety net for
drop, `6` only for high-risk tools.

**Design stance:** *never silently substitute a value you're not sure about.* Blocking a tool
call (layer 5) is strictly better than writing a corrupted secret into a real `.env`. The
failure mode becomes "ficta refused this write, here's why" — not "your file is silently broken."

## What stays non-deterministic — and how we contain it

The **drop** case (model emits a plausible *wrong* value instead of `S`) cannot be recovered:
there's nothing to match and it doesn't look corrupted. Defenses:

- **Layer 4 (round-trip integrity guard)** is the real answer: ficta remembers "surrogate `S` was
  sent up as part of file X's contents"; if the Write back to X is missing `S`, warn/block. This
  is stateful (keyed by file path / content region) but high-value, and **no competitor does it**
  because they don't model the file-level round-trip.
- **Layer 6** for the highest-risk writes.

Everything else (corruption, leak of a residual surrogate) is made deterministic: recovered or
blocked, never silently shipped.

## Implementation notes

- **Streaming.** Restore runs on the SSE `tool_use` deltas (`input_json_delta.partial_json` /
  OpenAI `function.arguments` deltas). The surrogate recognizer + checksum validation operate on
  the `StreamRestorer` holdback buffer; a fixed prefix + fixed length make the streamed match
  tractable. Validate the checksum once the full token is buffered.
- **JSON escaping.** When substituting `V` into a JSON string arg, **JSON-escape** it (real
  secrets contain `"`, `\`, `\n`) or you emit invalid tool-call JSON and break the call.
- **Vault lifetime.** Surrogate↔value map must live long enough to restore multi-turn echoes
  (see retention discussion in [`architecture-plan.md`](./architecture-plan.md)); deterministic HMAC surrogates keep this stable.

## Open questions for build time

- Exact surrogate grammar + checksum width per category (entropy vs length-preservation tradeoff).
- Granularity of the round-trip integrity guard (whole file vs per-line/region keying).
- Default for layer 6: which tools/paths count as "high-risk" enough to gate.
- Measured mutation rates per surrogate format — instrument early (count un-restored surrogates
  reaching the client, never log values) to validate the format-preserving bet empirically.
