# ficta — Competitive Landscape & Differentiation

> **Product definition & the short differentiation summary live in [`README.md`](../README.md).**
> This file is competitive analysis, not launch copy. Public claims should follow
> [`publishing.md`](./publishing.md) and the scoped threat model.

*Researched June 2026. Working name: ficta ("Airlock" framing).*

## TL;DR

The technology here is commodity — secret/PII **detection** should be reused (Gitleaks,
Presidio), not rebuilt. Plenty of tools detect secrets, several do reversible masking, and
**two OSS tools already do local + reversible + secrets** (LLM Guard, DontFeedTheAI) — so
"local & reversible & open-source" is **not** the moat; that bar is already met.

What survives as genuinely unfilled is narrower:

> **reversible *secrets*** (not just PII) · **secret-manager exact-match** (load `.env`/Doppler,
> keep *those* values out of covered model requests verbatim) · **native-wire, streaming-correct,
> tool-call round-trip** so an **agentic coding** client keeps editing real files · **one-command
> agent wrap** (`ficta claude`).

Every incumbent punts on the last two — the agentic round-trip is the part nobody ships
correctly (LiteLLM's is documented-broken; DontFeedTheAI explicitly excludes it). **Detection
breadth is not where we win.** The defensible bet is **the agentic round-trip done correctly +
distribution/trust**, not a detection moat. ⚠️ That wedge is also the hardest reliability
problem — see *Honest weaknesses*.

**Demand signal:** Claude Code feature request #29434 ("redact secrets/PII from the context
window") was **closed as not planned** — no first-party fix is coming.

---

## The five categories

### A. Secret scanning for AI coding tools — *closest on use case*

**ggshield (GitGuardian)** — scans Claude Code / Cursor / Copilot interactions through their
hook systems in real time; 500+ validated secret types.
- ✗ Detection runs on **GitGuardian's cloud API** — your prompts/files are uploaded to be
  scanned (ironic for a privacy tool).
- ✗ **Blocks** ("remove the secret") rather than masking — it interrupts the developer.
- **ficta diff:** local detection, reversible & non-breaking.

### B. Secret-detection engines — *we reuse, we don't compete*

- **Gitleaks** — MIT, local, ~150 regex rules, scans stdin, usable as a Go lib.
  → **Vendor the ruleset** (`config/gitleaks.toml`, attribution only).
- **TruffleHog** — AGPL-3.0, 800+ detectors **with live verification** (calls the API to
  confirm a secret is active). → **Optional opt-in subprocess** (keep AGPL at arm's length).

### C. Reversible LLM privacy vaults — *closest on the mechanism (now crowded)*

- **LLM Guard (Protect AI)** — **MIT, fully local**, modular scanners incl. `Anonymize`/
  `Deanonymize` with a reversible **Vault**, plus a **secrets** scanner; runs as a library or
  standalone HTTP API / Docker. **Strongest OSS analog on the mechanism.**
  ✗ Reversible Vault is **PII-centric**; the **Secrets scanner is one-way** `[REDACTED]`, not
  vaulted. ✗ Library/sidecar you wire into your app — **not** a transparent native-wire
  (Anthropic Messages/SSE) proxy; no streaming tool-call round-trip, no secret-manager match,
  no agent wrap.
  **ficta diff:** reversible *secrets*; native-wire streaming/tool-call restore; `.env`/Doppler
  exact-match; drop-in `ficta claude`.
- **Microsoft PII Shield** — a "privacy proxy for every LLM call": `/anonymize` → stable
  placeholders + session id; app posts the response to `/deanonymize`.
  ✗ Two-call app-integration (not transparent passthrough), PII-centric, no secrets/agentic
  round-trip.
- **Skyflow LLM Privacy Vault** — reversible tokenize → detokenize around the LLM call.
  ✗ Enterprise SaaS data-vault, PII-centric, infra-heavy; not a local dev tool.
- **LiteLLM + Presidio** (`output_parse_pii: true`) — reversible, self-hostable.
  ✗ PII-only, heavyweight proxy, and **documented-broken on streaming / Anthropic native
  API** (open issues #22821, #8359, #6247) — exactly the hard part `StreamRestorer` targets.
- **Private AI** — on-prem PII detect/redact, 50+ entity types across 50+ languages.
  ✗ PII/PHI-centric, commercial SDK/container; not secrets/secret-manager-aware.

### D. AI-DLP / LLM firewalls / gateways — *enterprise egress control*

- **Nightfall AI** — SaaS DLP; redacts the offending span in prompts to ChatGPT/Copilot/etc.
  ✗ Detection transits **their** infrastructure; SaaS/endpoint-oriented, not local.
- **Lakera Guard** — API-first runtime DLP (PII + secrets) + prompt-injection defense.
  ✗ Cloud API; block/flag model.
- **Cloudflare AI Gateway / Kong AI Gateway / Portkey** — LLM gateways with DLP/PII redaction
  as a feature. ✗ Infra/cloud, team-deployed, redact/block (not reversible), not dev-local.

### E. Direct OSS lookalikes — *the closest analogs, teardown'd*

**DontFeedTheAI** (`zeroc00I/LLM-anonymization`) — **closest on *mechanism*.** Local
anonymization proxy; **regex + on-device Ollama NER**; **per-engagement vault**; **reversible**
restore; supports **Claude Code / OpenAI / OpenRouter**; zero-egress detection.
- ✗ Pentest-engagement framing, **not secret-manager-aware**.
- ✗ **Explicitly out of scope: streaming, tool-use arguments, file-editing** — it stops exactly
  where ficta's hard part begins. **Validates the wedge in the author's own words.**
- **ficta diff:** native-wire **streaming + tool-call-arg** round-trip; secret-manager
  exact-match; one-command agent wrap.

**`aisecuritygateway` (AISG)** — self-hosted AI firewall by Datum Fuse LLC. Apache-2.0.
Python: **FastAPI + LiteLLM** (routing) + **Microsoft Presidio** (PII NER) + custom regex
for secrets + rule-based prompt-injection blocking. Local detection, no telemetry,
**fail-closed by default**, 8 providers (incl. Anthropic), OpenAI-SDK drop-in. Has a
commercial cloud tier (SAML/RBAC/SIEM). Maturity: early — **~22 stars, ~24 commits**
(Jun 2026); streaming added only in v1.1.0 (May 2026).

- **Decisive difference — it's one-way, not reversible.** Replaces values with `[REDACTED]`
  or blocks (`dlp.action: redact|block`). *"Original values are not recoverable."* The model
  sees `[REDACTED]` and the response is **not** restored → breaks the workflows ficta keeps
  working. **This is ficta's core wedge, and it's wide open.**
- **No secret-manager exact-match** (Presidio NER + regex only).
- **Infra-oriented on-ramp:** `git clone` + `docker compose up` + `.env` + ~500 MB spaCy
  model — no one-command agent wrap.
- **Built on LiteLLM/Presidio**, so likely inherits the same streaming/Anthropic-native
  fragility documented for that stack.
- **Verdict:** build fresh, don't fork (Python/LiteLLM, redact-or-block by design). But
  borrow: fail-closed default, no telemetry, the `gateway.yaml` policy shape (add `mask`),
  provider auto-discovery, OpenAI-SDK compatibility. **22 stars also says no one has won
  individual-dev adoption yet** — the category is unproven at the individual tier.

---

## Differentiation matrix

The separating rows are the **bottom four**, not "local/reversible/OSS" (already met by LLM
Guard and DontFeedTheAI).

| Capability | ggshield | LiteLLM+Presidio | LLM Guard | DontFeedTheAI | Skyflow | AISG | **ficta** |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Detection **100% local** | ✗ cloud | ✓ | ✓ | ✓ | ✗ | ✓ | **✓** |
| **Reversible** (restores real values) | ✗ | ✓ (PII) | ✓ (PII) | ✓ | ✓ (PII) | ✗ | **✓** |
| **Non-breaking** (agent keeps working) | ✗ blocks | ~ buggy | ~ (PII) | ✓ | ✓ | ✗ redacts | **✓** |
| **Secrets-first** (not just PII) | ✓ | ✗ | ~ (1-way) | ✓ | ✗ | ~ | **✓** |
| **OSS / auditable** | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | **✓** |
| **Reversible *secrets*** (vaulted, not redacted) | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | **✓** |
| **Secret-manager exact-match** (Doppler/.env) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | **✓** |
| **Streaming-correct** restore (native SSE) | n/a | ✗ #22821 | ✗ | ✗ excl. | ? | ? | **✓ verified; field-sensitive** |
| **Tool-call-arg round-trip** (agentic edits) | n/a | ✗ | ✗ | ✗ excl. | ✗ | ✗ | **✓ verified; field-sensitive** |
| **One-command agent wrap** (`ficta claude`) | ~ hooks | ✗ | ✗ | ~ | ✗ | ✗ | **✓** |

Honest read: the top five rows no longer separate us — **DontFeedTheAI matches four, even
reversible-secrets.** Real separation is the bottom four (secret-manager match + agentic
streaming/tool-call round-trip + the wrap). Treat those as reliability-sensitive until they have
more field mileage.

---

## Publishing guardrails

Do **not** use this file's category language as outbound marketing. In public docs/posts:

- don't pitch enterprise/compliance;
- don't claim full DLP;
- don't lead with PII;
- don't imply ficta is a sandbox or tool-exfiltration wall;
- don't use "secure" / "never leaks" without the exact-match covered-surface scope.

Preferred framing: **a beta OSS secret-hygiene tool for individual coding-agent users**.

## One-line positioning

> ficta is a local secret airlock for Claude Code, Codex, and Pi: registered `.env`, process-env,
> and Doppler values become deterministic placeholders before covered model requests, then are
> restored locally so the agent can keep working.

---

## Honest weaknesses (don't oversell)

- **The wedge is the hardest reliability problem.** The agentic round-trip restores real values
  *into the model's tool-call args* — but models can mutate placeholders (case, whitespace,
  splitting, "fixing" them). A missed restore can write a broken `FICTA_...` token into a real file
  and lose the value. Plausibly *why* incumbents punt. Treat streaming + tool-call correctness as
  verified-but-field-sensitive, not a reason to overclaim.
- **DontFeedTheAI already overlaps the easy rows** incl. reversible-secrets. The honest claim is
  narrower: secret-manager exact-match + local reversible agent workflow for supported clients.
- **Probabilistic detection can't promise a negative** — lead with the **covered-surface
  exact-match check** for known values; frame regex/NER as best-effort. Don't say "never leaks."
- **Market reality:** this niche is **OSS/free** (LLM Guard, DontFeedTheAI, AISG); enterprise
  budget already flows to Skyflow / Private AI / Nightfall / GitGuardian. Realistic framing is
  "a sharp OSS tool," not an enterprise/compliance product.
- **Detection breadth/accuracy:** ggshield (500+ validated), TruffleHog (800+ verified),
  Private AI (50+ entities / 50+ languages) all beat a vendored Gitleaks ruleset. We're
  strong on registered **secrets**; PII-like detector support is best-effort and should stay secondary.
- **No prompt-injection / jailbreak defense** (Lakera/Kong do). Deliberately out of scope —
  that's input-direction safety, not egress.
- **No enterprise control plane** (policy management, dashboards, SSO, audit export). Do not pitch
  one until it exists; it is outside the current publishing lane.
- **The trust ask is large:** ficta must sit in the path of all model traffic. Only
  **OSS + local + zero-egress** earns that — which is exactly why those are non-negotiable
  invariants, not features.
- **Funded incumbents** (GitGuardian, Cloudflare, Skyflow) have distribution and detection
  R&D we won't match. Compete on **friction and trust**, not feature count.

---

## Sources

- ggshield — github.com/GitGuardian/ggshield · docs.gitguardian.com (secret scanning for AI coding tools)
- Gitleaks — github.com/gitleaks/gitleaks
- TruffleHog — github.com/trufflesecurity/trufflehog
- LiteLLM + Presidio — docs.litellm.ai/docs/proxy/guardrails/pii_masking_v2 (issues #22821, #8359, #6247)
- Skyflow LLM Privacy Vault — skyflow.com/product/llm-privacy-vault
- Private AI — tooldirectory.ai/tools/private-ai · Nightfall — nightfall.ai/solutions/prevent-data-leakage-to-shadow-ai
- Lakera Guard — lakera.ai
- Cloudflare AI Gateway DLP — developers.cloudflare.com/ai-gateway/features/dlp
- LLM Guard — github.com/protectai/llm-guard · llm-guard.com (MIT; Anonymize/Deanonymize Vault + secrets scanner)
- Microsoft PII Shield — techcommunity.microsoft.com (privacy proxy: /anonymize + /deanonymize)
- DontFeedTheAI — github.com/zeroc00I/LLM-anonymization (local reversible proxy; excludes streaming/tool-use/file-editing)
- aisecuritygateway — github.com/aisecuritygateway/aisecuritygateway
- Demand signal — Claude Code feature request #29434 (redact secrets/PII from context window; closed as not planned)
