import { describe, expect, it } from "vitest";
import type { PluginDiscovery } from "../src/plugins/index.js";
import { renderStartupBanner } from "../src/startup-banner.js";

const discoveries: PluginDiscovery[] = [
  {
    id: "doppler-cli/secrets-download",
    plugin: "doppler-cli",
    label: "Doppler CLI",
    status: "loaded",
    valueCount: 34,
    message:
      "loaded current config via `doppler secrets download --no-file --format json`; skipped 4 shorter than 8 chars",
    details: ["current: 34 loaded"],
  },
  {
    id: "known-env-values/env-file",
    plugin: "known-env-values",
    label: "env files",
    status: "loaded",
    valueCount: 4,
    message: "read 1 file(s)",
    details: [".env: not found", ".env.local: 4 loaded"],
  },
  {
    id: "known-env-values/process-env",
    plugin: "known-env-values",
    label: "process env",
    status: "loaded",
    valueCount: 10,
    message: "enabled for secret-ish env names; skipped 4 shorter than 8 chars, 3 empty",
  },
];

describe("startup banner", () => {
  it("renders a compact default summary", () => {
    const rendered = renderStartupBanner({
      protectedValues: 47,
      agentCommand: "pi",
      baseUrl: "http://127.0.0.1:59717",
      discoveries,
    });

    expect(rendered).toBe(
      "🔒 ficta ready — 47 protected values (48 loaded before dedupe)\n" +
        "   pi → http://127.0.0.1:59717\n" +
        "   sources: Doppler 34, .env.local 4, process env 10\n",
    );
    expect(rendered).not.toContain("not found");
    expect(rendered).not.toContain("doppler secrets download");
  });

  it("prints detailed registry discovery only in verbose mode", () => {
    const rendered = renderStartupBanner({
      protectedValues: 47,
      agentCommand: "pi",
      baseUrl: "http://127.0.0.1:59717",
      discoveries,
      verbose: true,
    });

    expect(rendered).toContain("   source details:\n");
    expect(rendered).toContain("✓ Doppler CLI (34 values)");
    expect(rendered).toContain(".env: not found");
    expect(rendered).toContain("doppler secrets download");
  });

  it("calls out errored sources without dumping full details", () => {
    const rendered = renderStartupBanner({
      protectedValues: 1,
      agentCommand: "claude",
      baseUrl: "http://127.0.0.1:12345",
      discoveries: [
        { id: "ok", plugin: "test", label: "env files", status: "loaded", valueCount: 1 },
        { id: "bad", plugin: "test", label: "Doppler CLI", status: "error", valueCount: 0, message: "boom" },
      ],
    });

    expect(rendered).toContain("attention: 1 registry source errored");
    expect(rendered).not.toContain("boom");
  });
});
