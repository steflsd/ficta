import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const originalLogBodies = process.env.FICTA_LOG_BODIES;

afterEach(() => {
  if (originalLogBodies === undefined) delete process.env.FICTA_LOG_BODIES;
  else process.env.FICTA_LOG_BODIES = originalLogBodies;
});

describe("config hardening", () => {
  it("keeps raw body logging off by default", () => {
    delete process.env.FICTA_LOG_BODIES;
    expect(loadConfig().logBodies).toBe(false);
  });

  it("requires explicit opt-in for raw body logging", () => {
    process.env.FICTA_LOG_BODIES = "1";
    expect(loadConfig().logBodies).toBe(true);

    process.env.FICTA_LOG_BODIES = "0";
    expect(loadConfig().logBodies).toBe(false);
  });
});
