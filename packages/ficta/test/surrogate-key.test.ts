import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureSurrogateKey, readUserConfig } from "../src/user-config.js";

describe("ensureSurrogateKey", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ficta-key-"));
    path = join(dir, "config.toml");
    delete process.env.FICTA_SURROGATE_KEY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.FICTA_SURROGATE_KEY;
  });

  it("generates a 256-bit key when absent, persists it, and activates it", () => {
    const r = ensureSurrogateKey(path);
    expect(r.generated).toBe(true);
    expect(process.env.FICTA_SURROGATE_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(readUserConfig(path).FICTA_SURROGATE_KEY).toBe(process.env.FICTA_SURROGATE_KEY);
  });

  it("is idempotent — a fresh process re-reads the same key, never regenerates", () => {
    expect(ensureSurrogateKey(path).generated).toBe(true);
    const key = process.env.FICTA_SURROGATE_KEY;
    delete process.env.FICTA_SURROGATE_KEY; // simulate a new process before loadUserConfig
    const r = ensureSurrogateKey(path);
    expect(r.generated).toBe(false);
    expect(process.env.FICTA_SURROGATE_KEY).toBe(key);
  });

  it("does nothing when a key is already active in the environment", () => {
    process.env.FICTA_SURROGATE_KEY = "already-set";
    expect(ensureSurrogateKey(path).generated).toBe(false);
    expect(readUserConfig(path).FICTA_SURROGATE_KEY).toBeUndefined();
  });
});
