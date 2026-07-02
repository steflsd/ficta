# Intercepting Codex (ChatGPT/OAuth) through ficta

*How ficta dynamically routes OpenAI Codex CLI when Codex is logged in with a ChatGPT
subscription/OAuth account instead of an API key. Hard-won; don't re-derive. Prior art: headroom
(`headroom/providers/codex/install.py`).*

## Runtime model

Codex routing through ficta is **dynamic**. Do not add permanent ficta provider settings to
`~/.codex/config.toml`.

Use the wrapper or installed shim:

```sh
ficta codex
# or, after `ficta install`:
codex
```

For each launch, ficta:

1. starts an ephemeral local proxy on a random loopback port;
2. detects whether Codex is using ChatGPT/OAuth vs API-key auth;
3. injects temporary `codex -c ...` provider overrides for that process only;
4. restores normal behavior when the process exits.

Bypass once with:

```sh
FICTA_DISABLE=1 codex
```

## Why Codex OAuth needs special handling

Codex on ChatGPT/OAuth auth does **not** call `api.openai.com` for model turns. It calls the
**ChatGPT backend** (`https://chatgpt.com/backend-api/codex/responses`) with the OAuth bearer plus
a `chatgpt-account-id` header.

Two dead ends:

- **`openai_base_url` alone** only affects the built-in `openai` provider in API-key mode. OAuth
  Codex ignores it for model turns.
- **`chatgpt_base_url` alone** redirects Codex account/plugin/telemetry APIs
  (`/backend-api/{plugins,ps,wham,codex/analytics-events}`) but not the model `responses` call.

## The dynamic launch fix

For ChatGPT/OAuth Codex, ficta injects a temporary custom provider with
`requires_openai_auth=true`, pointing at the ephemeral ficta proxy. This makes Codex send model
traffic through ficta while still using its existing ChatGPT OAuth login.

For API-key Codex, ficta injects the simpler OpenAI-compatible provider override.

No persistent TOML changes are needed.

## Proxy routing

Codex posts model traffic to the temporary provider's `/responses` endpoint. ficta then routes by
auth mode:

| Incoming (from Codex) | OAuth? | Forwarded to |
|---|---|---|
| `/v1/responses`, `/v1/codex/responses` | yes | `https://chatgpt.com/backend-api/codex/responses` |
| `/v1/responses` | no (API key) | `https://api.openai.com/v1/responses` |
| `/v1/models` | yes | `https://chatgpt.com/backend-api/codex/models` |
| `/backend-api/*` | — | `https://chatgpt.com/backend-api/*` |

All required auth headers are forwarded untouched, so Codex auth continues to work.
`FICTA_CHATGPT_UPSTREAM` overrides the ChatGPT host if needed; default is `https://chatgpt.com`.

## Verify routing without exposing real secrets

Check launch configuration first:

```sh
ficta doctor codex
```

Then run a harmless request:

```sh
ficta codex exec --skip-git-repo-check "say hello"
```

Expect:

- ficta prints a registry-source report with counts/source names only, never values;
- Codex shows `provider: ficta` for the wrapped launch;
- ficta metadata logs show model traffic routed to the expected upstream, e.g.
  `https://chatgpt.com/backend-api/codex/responses` for ChatGPT/OAuth.

If you want a redaction proof, use a **fake fixture value**, not a real `.env` secret, and keep raw
body logs off unless debugging.

## Notes

- Codex wraps tool output as `Chunk ID: … / Original token count: N / Output: …`. Small outputs are
  inlined; large outputs may be elided or referenced.
- What reaches the model depends on the agent's command. `cat .env` sends values through the model
  channel; ficta redacts registered values before forwarding, but don't use real secrets as an
  onboarding test.
- Codex is chatty: `/backend-api/{plugins,ps/mcp,codex/analytics-events,wham/usage}` housekeeping
  may appear on startup; the default `info` level already shows only model turns (raise to
  `FICTA_LOG_LEVEL=debug` to see this non-model traffic).
- `codex exec` needs `--skip-git-repo-check` when the cwd isn't a git repo.
