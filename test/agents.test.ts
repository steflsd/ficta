import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentCommands,
  claudeAgent,
  codexAgent,
  codexPersistedFictaCleanupOverrides,
  findAgentIntegration,
  piAgent,
  piProviderExtension,
} from "../src/plugins/index.js";

const BASE = "http://127.0.0.1:8787";

describe("agent integration plugins", () => {
  it("exposes built-in agent commands through the plugin registry", () => {
    expect(agentCommands()).toEqual(expect.arrayContaining(["claude", "codex", "pi"]));
    expect(findAgentIntegration("pi")?.label).toContain("Pi");
  });

  it("marks non-model agent commands for passthrough", () => {
    expect(claudeAgent.shouldBypass?.(["--version"])).toBe(true);
    expect(codexAgent.shouldBypass?.(["--help"])).toBe(true);
    expect(piAgent.shouldBypass?.(["install", "npm:@pkg/example"])).toBe(true);
    expect(piAgent.shouldBypass?.(["-p", "hello"])).toBe(false);
  });

  it("configures Claude Code via ANTHROPIC_BASE_URL", () => {
    const plan = claudeAgent.configureLaunch({
      baseUrl: BASE,
      args: ["--version"],
      realExecutable: "/bin/claude",
      env: {},
      cwd: process.cwd(),
    });

    expect(plan.executable).toBe("/bin/claude");
    expect(plan.args).toEqual(["--version"]);
    expect(plan.env.ANTHROPIC_BASE_URL).toBe(BASE);
  });

  it("configures Codex API-key mode through a temporary provider override", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-api-home-"));
    const plan = codexAgent.configureLaunch({
      baseUrl: BASE,
      args: ["exec", "hello"],
      realExecutable: "/bin/codex",
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan.executable).toBe("/bin/codex");
    expect(plan.args).toEqual([
      "-c",
      'model_provider="ficta"',
      "-c",
      'model_providers.ficta.name="ficta"',
      "-c",
      `model_providers.ficta.base_url="${BASE}/v1"`,
      "exec",
      "hello",
    ]);
  });

  it("configures Codex ChatGPT/OAuth mode when auth.json says chatgpt", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-home-"));
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));

    const plan = codexAgent.configureLaunch({
      baseUrl: BASE,
      args: [],
      realExecutable: "/bin/codex",
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan.args).toContain("model_providers.ficta.requires_openai_auth=true");
    expect(plan.args).toContain(`chatgpt_base_url="${BASE}/backend-api/"`);
  });

  it("neutralizes stale persisted Codex ficta routing on FICTA_DISABLE bypass", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-stale-home-"));
    writeFileSync(
      join(home, "config.toml"),
      [
        'model_provider = "ficta"',
        'openai_base_url = "http://localhost:8787/v1"',
        'chatgpt_base_url = "http://localhost:8787/backend-api/"',
        "",
        "[model_providers.ficta]",
        'base_url = "http://localhost:8787/v1"',
      ].join("\n"),
    );

    expect(codexPersistedFictaCleanupOverrides({ CODEX_HOME: home })).toEqual([
      'model_provider="openai"',
      'openai_base_url="https://api.openai.com/v1"',
      'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    ]);

    const plan = codexAgent.configureBypass?.({
      args: ["exec", "hello"],
      realExecutable: "/bin/codex",
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan?.args).toEqual([
      "-c",
      'model_provider="openai"',
      "-c",
      'openai_base_url="https://api.openai.com/v1"',
      "-c",
      'chatgpt_base_url="https://chatgpt.com/backend-api/"',
      "exec",
      "hello",
    ]);
  });

  it("bypasses stale Codex ficta routing to ChatGPT backend for OAuth auth", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-stale-oauth-home-"));
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
    writeFileSync(
      join(home, "config.toml"),
      [
        'model_provider = "ficta"',
        'chatgpt_base_url = "http://localhost:8787/backend-api/"',
        "",
        "[model_providers.ficta]",
        'base_url = "http://localhost:8787/v1"',
        "requires_openai_auth = true",
      ].join("\n"),
    );

    expect(codexPersistedFictaCleanupOverrides({ CODEX_HOME: home })).toEqual([
      'model_provider="ficta_direct_chatgpt"',
      'model_providers.ficta_direct_chatgpt.name="ChatGPT direct (ficta bypass)"',
      'model_providers.ficta_direct_chatgpt.base_url="https://chatgpt.com/backend-api/codex"',
      "model_providers.ficta_direct_chatgpt.requires_openai_auth=true",
      'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    ]);
  });

  it("leaves Codex bypass args alone when no stale persisted ficta routing is present", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-codex-clean-home-"));
    writeFileSync(join(home, "config.toml"), 'model_provider = "openrouter"\n');

    const plan = codexAgent.configureBypass?.({
      args: ["exec", "hello"],
      realExecutable: "/bin/codex",
      env: { CODEX_HOME: home },
      cwd: process.cwd(),
    });

    expect(plan?.args).toEqual(["exec", "hello"]);
  });

  it("configures Pi with a temporary provider override extension", async () => {
    const plan = piAgent.configureLaunch({
      baseUrl: BASE,
      args: ["--version"],
      realExecutable: "/bin/pi",
      env: {},
      cwd: process.cwd(),
    });
    const extensionPath = plan.args[1];

    expect(plan.executable).toBe("/bin/pi");
    expect(plan.args[0]).toBe("-e");
    expect(plan.args.slice(2)).toEqual(["--version"]);
    expect(plan.env.FICTA_BASE_URL).toBe(BASE);
    expect(extensionPath).toBeTruthy();
    expect(readFileSync(extensionPath ?? "", "utf8")).toContain('pi.registerProvider("anthropic"');

    await plan.cleanup?.();
    expect(existsSync(extensionPath ?? "")).toBe(false);
  });

  it("Pi extension routes Anthropic and OpenAI built-in providers through /v1", () => {
    const source = piProviderExtension();
    expect(source).toContain('pi.registerProvider("anthropic", { baseUrl: v1 })');
    expect(source).toContain('pi.registerProvider("openai", { baseUrl: v1 })');
  });
});
