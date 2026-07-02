import { describe, expect, it } from "vitest";
import type { EffectiveRegistryExclusionRule, PluginRegistrySnapshot } from "../src/plugins/index.js";
import { USER_EXCLUSION_PLUGIN, USER_EXCLUSION_RULE_ID } from "../src/plugins/index.js";
import { collectReviewCandidates, initialSelection, nextExcludeNames, type ReviewCandidate } from "../src/review.js";

function userRule(names: string[]): EffectiveRegistryExclusionRule {
  return {
    id: USER_EXCLUSION_RULE_ID,
    kind: "env-name",
    names,
    reason: "test",
    plugin: USER_EXCLUSION_PLUGIN,
    trusted: true,
  };
}

function pluginRule(names: string[]): EffectiveRegistryExclusionRule {
  return {
    id: "doppler-metadata-env-names",
    kind: "env-name",
    names,
    reason: "test",
    plugin: "doppler-registry",
    trusted: true,
  };
}

function snapshot(partial: Partial<PluginRegistrySnapshot>): PluginRegistrySnapshot {
  return {
    values: [],
    pluginNames: [],
    discoveries: [],
    registryPolicy: { exclusions: [] },
    policyExcluded: 0,
    policyExcludedBySource: {},
    policyExcludedValues: [],
    ...partial,
  };
}

describe("collectReviewCandidates", () => {
  it("classifies protected, user-excluded, plugin-excluded, and stale names", () => {
    const uRule = userRule(["USER_OFF", "GONE"]);
    const pRule = pluginRule(["DOPPLER_CONFIG"]);
    const candidates = collectReviewCandidates(
      snapshot({
        values: [
          { name: "API_KEY", value: "x", source: "env-file", plugin: "known-env-values" },
          { name: "API_KEY", value: "x", source: "process-env", plugin: "known-env-values" },
        ],
        registryPolicy: { exclusions: [uRule, pRule] },
        policyExcludedValues: [
          { name: "USER_OFF", source: "env-file", plugin: "known-env-values", rule: uRule },
          { name: "DOPPLER_CONFIG", source: "process-env", plugin: "known-env-values", rule: pRule },
        ],
      }),
    );

    const byName = new Map(candidates.map((c) => [c.name, c]));
    expect(byName.get("API_KEY")?.state).toBe("protected");
    expect(byName.get("API_KEY")?.sources.sort()).toEqual(["env-file", "process-env"]);
    expect(byName.get("USER_OFF")?.state).toBe("user-excluded");
    expect(byName.get("DOPPLER_CONFIG")?.state).toBe("plugin-excluded");
    expect(byName.get("DOPPLER_CONFIG")?.excludedBy).toBe("doppler-registry");
    // In the user list but matched no source → stale.
    expect(byName.get("GONE")?.state).toBe("stale-excluded");
    expect(byName.get("GONE")?.sources).toEqual([]);
  });
});

describe("collectReviewCandidates — classification", () => {
  it("classifies protected candidates (incl. doppler-sourced), and leaves excluded/stale unclassified", () => {
    const uRule = userRule(["USER_OFF"]);
    const candidates = collectReviewCandidates(
      snapshot({
        values: [
          { name: "OPENAI_API_KEY", value: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", source: "process-env" },
          { name: "WORKOS_REDIRECT_URI", value: "https://app.example.com/cb", source: "doppler" },
        ],
        registryPolicy: { exclusions: [uRule] },
        policyExcludedValues: [{ name: "USER_OFF", source: "env-file", plugin: "known-env-values", rule: uRule }],
      }),
    );
    const byName = new Map(candidates.map((c) => [c.name, c]));
    expect(byName.get("OPENAI_API_KEY")?.classification?.verdict).toBe("keep-protected");
    // Doppler-sourced URL gets the same treatment as any other source.
    expect(byName.get("WORKOS_REDIRECT_URI")?.classification?.verdict).toBe("likely-non-secret");
    expect(byName.get("USER_OFF")?.classification).toBeUndefined();
  });

  it("aggregates values across sources — any secret-looking value keeps the name protected", () => {
    const candidates = collectReviewCandidates(
      snapshot({
        values: [
          { name: "SERVICE_URL", value: "https://api.example.com", source: "env-file" },
          { name: "SERVICE_URL", value: "https://user:pass@api.example.com", source: "process-env" },
        ],
      }),
    );
    expect(candidates[0]?.classification?.verdict).toBe("keep-protected");
  });
});

describe("initialSelection", () => {
  it("pre-selects protected names except likely non-secrets", () => {
    const candidates = collectReviewCandidates(
      snapshot({
        values: [
          { name: "OPENAI_API_KEY", value: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", source: "process-env" },
          { name: "WORKOS_REDIRECT_URI", value: "https://app.example.com/cb", source: "doppler" },
          { name: "AWS_PROFILE", value: "eu-central-1-prod", source: "process-env" },
        ],
      }),
    );
    expect(initialSelection(candidates)).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("nextExcludeNames", () => {
  const candidates: ReviewCandidate[] = [
    { name: "KEEP_ON", sources: ["env-file"], state: "protected" },
    { name: "TURN_OFF", sources: ["env-file"], state: "protected" },
    { name: "USER_OFF", sources: ["env-file"], state: "user-excluded" },
    { name: "STALE", sources: [], state: "stale-excluded" },
    { name: "DOPPLER_CONFIG", sources: ["process-env"], state: "plugin-excluded", excludedBy: "doppler-registry" },
  ];
  const current = ["USER_OFF", "STALE"];

  it("adds deselected protected names and keeps deselected exclusions", () => {
    // Selected = names the user keeps protecting. USER_OFF and STALE left unselected.
    const result = nextExcludeNames(candidates, new Set(["KEEP_ON"]), current);
    expect(result).toEqual(["STALE", "TURN_OFF", "USER_OFF"]);
  });

  it("removes an excluded name when the user re-selects it, including stale entries", () => {
    const result = nextExcludeNames(candidates, new Set(["KEEP_ON", "TURN_OFF", "USER_OFF", "STALE"]), current);
    expect(result).toEqual([]);
  });

  it("never excludes a plugin-owned name even if somehow selected or not", () => {
    const result = nextExcludeNames(candidates, new Set(["KEEP_ON", "TURN_OFF", "USER_OFF", "STALE"]), current);
    expect(result).not.toContain("DOPPLER_CONFIG");
  });
});
