# Installing ficta shims

The preferred runtime shape is an **ephemeral proxy per agent session**: secrets are discovered in
the current project/env, kept in memory for that session, then forgotten when the agent exits.

Install ficta globally with your package manager:

```sh
# npm
npm install -g @steflsd/ficta@beta

# pnpm (run `pnpm setup` first if pnpm global bins are not configured)
pnpm add -g @steflsd/ficta@beta

# bun
bun install --global @steflsd/ficta@beta
```

Then, to avoid relying on muscle memory (`ficta claude` every time), install shell shims once:

```sh
ficta setup   # configure ~/.ficta/config.toml and optionally install shims
# or just install shims directly:
ficta install
```

From a source checkout, use `pnpm ficta setup` / `pnpm ficta install` instead.

Before launching an agent, sanity-check registry loading and routing:

```sh
ficta doctor claude   # or codex / pi
```

Then restart your shell and use your normal commands:

```sh
claude
codex
pi
```

The installed files are generated from agent-integration plugins:

```txt
~/.ficta/bin/.ficta-launcher -> hidden launcher for the installed ficta CLI, using /usr/bin/env node
~/.ficta/bin/claude          -> calls the sibling launcher as: .ficta-launcher claude "$@"
~/.ficta/bin/codex           -> calls the sibling launcher as: .ficta-launcher codex "$@"
~/.ficta/bin/pi              -> calls the sibling launcher as: .ficta-launcher pi "$@"
```

ficta intentionally does **not** install `~/.ficta/bin/ficta`, so the `ficta` command remains the
global package-manager CLI. Upgrading is just rerunning your global install command, for example
`npm install -g @steflsd/ficta@beta`, `pnpm add -g @steflsd/ficta@beta`, or
`bun install --global @steflsd/ficta@beta`.

Only the hidden launcher contains the installed CLI path, so moving a development checkout only
requires rerunning `pnpm ficta install --force` to refresh one generated file.

`ficta install` also adds `~/.ficta/bin` to your shell startup file (`~/.zshrc`, `~/.bashrc`, or
`~/.profile`) using a managed block.

## Why shims instead of an always-on proxy?

Shims preserve the important privacy properties:

- the registry is discovered from the current working directory (`.env`, `.env.local`) and configured sources in `~/.ficta/config.toml`
- Doppler CLI secrets are loaded before the agent starts; `doppler run -- claude` / `doppler run -- pi` can also be covered by enabling process-env loading
- secrets live only for the agent session
- multiple projects do not share one long-lived vault

## Agent integrations

Agent shims are backed by built-in agent-integration plugins:

- `claude`: sets `ANTHROPIC_BASE_URL` for Claude Code.
- `codex`: injects temporary `-c model_provider=...` overrides, including ChatGPT/OAuth handling.
- `pi`: injects a temporary Pi extension (`-e <tmp>/ficta-provider.ts`) that calls
  `pi.registerProvider()` for the built-in `anthropic` and `openai` providers, preserving Pi's
  normal auth/model selection for those providers. Other Pi providers need their own adapter/wire
  support before they are covered.

Non-model commands such as `--version`, `--help`, and Pi package-management commands (`pi install`,
`pi update`, etc.) pass through directly to the real agent without starting a proxy.

## Empty registry behavior

If no protected values load, ficta warns and launches the agent in passthrough mode by default:

```txt
⚠ no protected values loaded — launching anyway in passthrough mode
```

To get protection in that project, add/point at registry sources with `ficta setup` or by editing
`~/.ficta/config.toml`:

```toml
[registry.env_file]
enabled = true
paths = [".env", ".env.production"]

[registry.process_env]
enabled = true
mode = "secret-ish"

[registry.doppler]
enabled = true
configs = ["dev", "prod"]
```

Shell `FICTA_*` environment variables can still override these settings for one run.

If you want strict startup blocking instead, set `registry.require = true` in config, or override once:

```sh
FICTA_REQUIRE_REGISTRY=1 claude
```

With strict mode enabled, bypass once with:

```sh
claude --allow-empty
# or
FICTA_ALLOW_EMPTY=1 claude
```

## Disable or bypass

If you need the real agent without ficta once:

```sh
FICTA_DISABLE=1 claude
FICTA_DISABLE=1 codex
FICTA_DISABLE=1 pi
```

To turn installed shims off globally without uninstalling them:

```sh
ficta disable
# later:
ficta enable
```

`ficta disable` writes `~/.ficta/disabled`; shims and `ficta <agent>` bypass the proxy while that
file exists. `ficta enable` removes it.

The shim resolves the real agent executable outside `~/.ficta/bin` to avoid recursion.

## Uninstall

If you installed the published package:

```sh
ficta uninstall
```

From a source checkout:

```sh
pnpm ficta uninstall
```

This removes ficta-owned shims and the managed PATH block. It will not delete/overwrite non-ficta
files that happen to exist in `~/.ficta/bin`.

## Options

```sh
ficta install --no-shell   # write shims but do not edit shell rc
ficta install --force      # overwrite existing files in ~/.ficta/bin
ficta uninstall --no-shell # remove shims but leave shell rc unchanged
```

From a source checkout, prefix these with `pnpm` as `pnpm ficta ...`.
