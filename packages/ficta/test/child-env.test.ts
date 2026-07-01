import { describe, expect, it } from "vitest";
import { sanitizeAgentEnv } from "../src/child-env.js";

describe("child agent environment", () => {
  it("does not pass the local surrogate key to child agents", () => {
    const env = sanitizeAgentEnv({
      FICTA_SURROGATE_KEY: "local-proxy-secret",
      ANTHROPIC_API_KEY: "provider-auth-still-needed",
      PATH: "/usr/bin",
    });

    expect(env.FICTA_SURROGATE_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("provider-auth-still-needed");
    expect(env.PATH).toBe("/usr/bin");
  });
});
