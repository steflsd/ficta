# TODO — code-review findings (feat/pii)

From a high-effort workflow code review of the `feat/pii` branch (PII detector, async
detection, monorepo migration, Turbo). Captured 2026-07-01. All 8 findings were independently
verified. The migration/Turbo/web changes surfaced no correctness issues; everything below is in
the PII detector.

**Quick wins #3–#6 fixed 2026-07-01** (verified: 126 tests green, Biome clean). Remaining:
**#1, #2** (design pass) and **#7, #8** (optional).

> Path note: the review referenced both `src/…` and `packages/ficta/src/…` because the diff
> includes the migration rename. Current path is `packages/ficta/src/…`.

---

## Open — matters before the gateway is real

- [ ] **1. Detected PII accumulates in the process-lifetime vault forever.**
  `packages/ficta/src/engine.ts` — `registerDetectedValues()` → `vault.register()`; Vault state in
  `vault.ts` (`values`/`seen`/`toSur`/`toVal`).
  - **What:** every distinct email/SSN/card a request contains is registered into the shared
    `Vault` and never evicted.
  - **Why it matters (shared gateway):** unbounded heap; each request re-scans the whole
    accumulated set (`replaceKnown` loops all values) and re-sorts on each new value → latency
    creep; **all prior clients' plaintext PII stays in memory** — a data-retention hazard.
  - **Root cause:** the CLI-era engine assumes a fixed, small registry; per-request *detection*
    breaks that assumption.
  - **Direction:** make detected values **request-scoped** — build the value→surrogate map for the
    request, use it for that response's restore, then discard — instead of registering into the
    global vault. Ties into the per-tenant engine idea in `docs/pii-gateway-north-star.md`. Also
    resolves the retention angle of #2.
  - **For analysis:** how to scope restore state when redact (request) and restore (response) share
    the same `server.ts` handler invocation; whether registered secrets and detected PII should live
    in separate vault layers (permanent vs per-request).

- [ ] **2. Numeric-JSON PII is detected but never redacted.**
  `packages/ficta/src/engine.ts` — `redactBodyDetailed()` (detection on raw body string vs
  `vault.redactBodyDetailed` which only rewrites JSON **string leaves**).
  - **What:** `{"card": 4111111111111111}` (a number leaf) is matched on the raw text and
    registered, but can't be replaced. Fail-closed **on** (default) → request **rejected**
    (availability); **off** → card **forwards to the vendor**.
  - **Scope:** chat payloads put pasted content in string leaves, so the common path is fine; this
    is the numeric-primitive edge (same class exists for registered numeric secrets).
  - **Direction:** run detection over the same string leaves that get redacted (detected ==
    redactable), or document the numeric-primitive limitation explicitly.

## Optional cleanup

- [ ] **7. Redundant plugin-level `seen` dedup.** `packages/ficta/src/plugins/pii/index.ts`
  — recognizer and vault already dedup. Mildly defensible once a 2nd recognizer (Presidio) exists,
  so decide when wiring the async recognizer.
- [ ] **8. Test-only async wrappers.** `packages/ficta/src/engine.ts` — `redactBody`/`redactText`
  (non-detailed) are now only used by tests; the server uses the `*Detailed` variants. Remove +
  update tests, or keep as public API.

---

## Done (2026-07-01)

- [x] **3. `engine.enabled` always true → false "🔒 redacting" banner during passthrough.**
  Added `ProtectionEngine.protecting` (also on the `RedactionEngine` interface): true only for
  registered values or a detector whose `discover()` reports it active — false during pure
  passthrough. `server.ts` now uses `engine.protecting` for both the banner **and** the `protect`
  request gate, so a disabled-detector/no-secrets proxy no longer claims redaction *or* runs the
  redact path for nothing (also resolves the review's "runs redact path in passthrough" angle).
  `enabled` semantics + the detector contract are unchanged (bare detectors without `discover()`
  still count as active). Test: `pii.test.ts` "reports `protecting` only when actually active".
- [x] **4. Credit-card regex absorbed a trailing separator.** `regex-recognizer.ts` — pattern
  changed to `/\b\d(?:[ -]?\d){12,18}\b/g` so the match always ends on a digit (no trailing
  space/hyphen pulled into the token). Test: "does not absorb a trailing separator into the card
  value".
- [x] **5. Stale "synchronous / async skipped" comment.** `pii/index.ts` — updated to reflect the
  now-async detection path (`detectText` awaits each recognizer).
- [x] **6. Stale "forthcoming PII detector plugin" comment.** `pii/recognizer.ts` — the plugin
  ships in this change; comment now points at `pii/index.ts`.

## Suggested next sequencing
1. **#1 request-scoped detection** — the real design decision (also dissolves #2's retention angle);
   revisit #2 numeric handling and #7 dedup while in there.
2. **#8** optional cleanup.
