# Publishing and positioning

This repo should be published as a **beta OSS developer tool for individual coding-agent users**,
not as enterprise DLP, a compliance control, or a general LLM security product.

## Preferred short pitch

> ficta is a local secret airlock for Claude Code, Codex, and Pi: registered `.env`, process-env,
> and Doppler values are replaced with deterministic placeholders before covered model requests and
> restored locally so the agent can keep working.

Use the scope sentence near any public claim:

> Protects registered values in their verbatim form in covered request bodies, query strings, and
> non-auth headers; transformed/unregistered values and tool-execution exfiltration are out of
> scope.

## Say this

- **Secrets-first**, especially values developers already manage in `.env`, process env, or Doppler.
- **Local, no telemetry, auditable OSS.** The trust argument is local code + readable boundary docs.
- **Exact-match protection for registered values** with fail-closed blocking if one would be
  forwarded verbatim in a covered surface.
- **Reversible agent workflow**: placeholders go to the model; real values are restored locally so
  file edits and commands can still work.
- **Personal hygiene / peace of mind** for individual developers and contractors using coding
  agents.

## Do not say this

- Do **not** pitch ficta as enterprise DLP, a compliance product, or a SOC/audit control.
- Do **not** claim full DLP, full prompt privacy, or that ficta catches every secret.
- Do **not** lead with PII. Detector plugins can support best-effort PII-like values, but the
  product promise is registered secret values.
- Do **not** claim ficta is a sandbox or exfiltration prevention system. Agent tool calls such as
  `curl`, MCP tools, or custom scripts need OS/container/agent controls.
- Do **not** use blanket phrases like "secure", "never leaks", or "keeps all secrets safe" without
  the exact scope sentence above.
- Do **not** launch to a broad Product Hunt-style audience before field-testing reliability with
  coding-agent power users.

## First audience

Start with developers who already feel the pain:

- Claude Code / Codex power users;
- devs and contractors with client repos containing `.env` or Doppler secrets;
- security-conscious solo developers who still want agent workflows to work;
- small trusted OSS/security-devtool communities before any broad launch.

## Release posture

- Label early releases as beta / pre-1.0.
- Publish the npm package as `@steflsd/ficta` with the `beta` dist-tag until field-tested.
- Document beta installs as global package-manager installs (`npm install -g @steflsd/ficta@beta`, `pnpm add -g @steflsd/ficta@beta`, `bun install --global @steflsd/ficta@beta`) until a `latest` release exists.
- Keep [`threat-model.md`](./threat-model.md) and [`SECURITY.md`](../SECURITY.md) prominent.
- Encourage `ficta doctor <agent>` before first use.
- Use fake fixture values for redaction demos; never ask users to prove behavior with real secrets.

## npm beta checklist

Configure npm Trusted Publishing for this repository using the `.github/workflows/publish.yml`
workflow and the `npm-publish` environment. Keep release notes under `## Unreleased`, then run the
local release script:

```sh
pnpm release:beta        # 0.1.0-beta.0 -> 0.1.0-beta.1; updates CHANGELOG.md too
pnpm publish:dry         # optional local package-content dry run

git log --oneline -2     # review release commit + next-cycle changelog commit
VERSION=$(node -p "require('./package.json').version")
git push origin main
git push origin "v$VERSION"
```

The tag push triggers CI publishing with npm provenance and creates/updates the GitHub Release from
the matching `CHANGELOG.md` section. Prerelease versions publish with the first prerelease identifier
as the npm dist-tag (`0.1.0-beta.1` -> `beta`); stable versions publish as `latest`.

For the first stable release from a beta, use `pnpm release:stable` to drop the prerelease suffix
(for example `0.1.0-beta.4` -> `0.1.0`). For later stable releases, use `pnpm release:patch` /
`minor` / `major`.
