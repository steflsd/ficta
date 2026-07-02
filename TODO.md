# TODO — code-review findings (feat/pii)

From a high-effort workflow code review of the `feat/pii` branch (PII detector, async
detection, monorepo migration, Turbo). Captured 2026-07-01. All 8 findings were independently
verified. The migration/Turbo/web changes surfaced no correctness issues; everything below is in
the PII detector.

**Quick wins #3–#6 fixed 2026-07-01** (verified: 126 tests green, Biome clean).
**#1, #2, #8 fixed 2026-07-01** in the request-scoped PII pass (verified: 132 tests green, Biome
clean, tarball file list unchanged).
**Pilot polish 2026-07-01** — PII default-on in `ficta setup`, `active` discovery status, and the
symmetric restore-count log line (verified: 133 tests green, Biome clean). See "Pilot polish" below.
**Loopback E2E 2026-07-02** — CI-safe PII round-trip through the real proxy handler landed
(`test/loopback-pii.test.ts`); verified: 156 tests green, Biome clean. **#7** resolved (Presidio
landed, dedup kept). Remaining before the gateway is real: **live E2E run** (user-driven, real key).

> Path note: the review referenced both `src/…` and `packages/ficta/src/…` because the diff
> includes the migration rename. Current path is `packages/ficta/src/…`.

---

## Open — matters before the gateway is real

- [ ] **Live E2E run (user-driven, real key, outward-facing).** `cp apps/web/.env.example
  apps/web/.env`, add a real OpenAI/Anthropic key, `FICTA_PII_ENABLED=1 pnpm dev`, paste **fake**
  PII in the UI at `http://localhost:4747` → confirm the answer streams back with restored values and
  the missing-key path shows a graceful error. Deliberately separate from CI (sends the fake content
  to a real vendor); run after the loopback + units are green (they are).

---

## Done (2026-07-01) — pilot polish (post-review)

Refinements on top of the request-scoped pass, from proving the feature end-to-end in the web UI:

- [x] **PII defaults on after `ficta setup`.** The wizard prompt now defaults **yes** and names the
  current recognizer (`setup.ts`): if you're standing up a PII gateway, detection shouldn't ship
  idle. "best-effort MVP" is a caveat on the *recognizer's* coverage, not a reason to leave the
  concept off. The No path stays for the shared-proxy/CLI case (the regex can tokenize an email in
  agent code you didn't care about). Two defaults by design: an unconfigured proxy is still **off**
  (`envDefaults FICTA_PII_ENABLED=0`); `FICTA_PII_ENABLED=0` remains an explicit force-off. Docs
  reconciled (`docs/plugins.md`, `apps/web/README.md`).
- [x] **Detector discovery reports `active`, not a misleading `(0 values)`.** Added a first-class
  `active` plugin-discovery status (`plugins/types.ts`, → `✓` in `plugins/index.ts`); the `pii`
  detector reports `active` with **no** `valueCount` when enabled, since a detector holds no
  preloaded values — it matches each request at runtime. The old `! PII detector (0 values)` banner
  read as idle/broken. Test: `pii.test.ts` "declares a config binding and reports its status".
- [x] **Symmetric restore-count log line.** Responses now log `♻️ ficta #N — restored M value(s) in
  response`, mirroring the egress `🔒 … kept N`. The vault view accumulates a `restored` Set across
  buffered **and** streaming restore; `restoredCount` is surfaced on the `RequestScope` interface;
  `server.ts` logs it inline for buffered bodies and via a `tapStreamFlush` pass-through for streamed
  bodies (so the count is final — it prints after `← #N` for streams, honest timing). Guarded by
  `restoredCount > 0 && !cfg.silent`, so zero-restore turns stay quiet. Test: `pii.test.ts` "counts
  distinct values restored back into a request's response".

## Done (2026-07-01) — request-scoped PII pass

- [x] **1. Detected PII no longer accumulates in the process-lifetime vault.** The vault now has two
  layers (`vault.ts`): a **permanent** layer (registered secrets, shared, unchanged) and an
  **ephemeral per-request** layer (`ScopedVault`). `engine.beginRequest(scopeKey?)` (on the
  `RedactionEngine` interface) opens a fresh scope; `server.ts` opens one per request and drops it at
  handler end, so detected values are bounded and GC'd. Restore consults detected-then-permanent, and
  the detected `toVal` is **private to the scope**, which closes the cross-client leak (client B's
  restore can never hand back client A's PII — see the deterministic-HMAC surrogate). `scopeKey` is
  the reserved seam for a future persistent/shared (session/org) vault; ignored today. Tests:
  `scope.test.ts` (leak isolation, ephemerality, cross-turn consistency).
- [x] **2. Numeric-JSON PII no longer trips the fail-closed gate.** Detection runs over
  `redactableBodyText(body)` — the JSON **string leaves** (values + object keys) that redaction can
  actually rewrite — so "detected == redactable". `{"card": 4111…}` (a number leaf) is neither
  detected nor flagged as a leak, so the request forwards unchanged instead of being rejected. The
  numeric-primitive limitation is documented at `redactableBodyText` (a string surrogate cannot
  replace a JSON number without changing the leaf's type); registered numeric secrets are unaffected
  (they enter the permanent vault directly and the leak backstop still scans primitives). Tests:
  `scope.test.ts` "detection matches the redactable surface".
- [x] **8. Test-only async wrappers removed.** `ProtectionEngine.redactBody`/`redactText`
  (non-detailed) are gone; the engine exposes only the `*Detailed` variants (used by the server and
  now the tests). `engine.test.ts` updated to call `redactBodyDetailed`.

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

1. **Live E2E** — the outward-facing single-user pilot run with a real key; sends fake content to a
   real vendor, so it's a deliberate separate step.
