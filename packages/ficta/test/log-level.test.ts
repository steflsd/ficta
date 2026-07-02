import { describe, expect, it, vi } from "vitest";
import { LOG_LEVELS, levelEnabled, parseLogLevel } from "../src/log-level.js";

describe("parseLogLevel", () => {
  it("returns the fallback when unset or empty", () => {
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("")).toBe("info");
    expect(parseLogLevel("   ")).toBe("info");
    expect(parseLogLevel(undefined, "silent")).toBe("silent");
  });

  it("accepts every level name, case-insensitively and trimmed", () => {
    for (const level of LOG_LEVELS) {
      expect(parseLogLevel(level)).toBe(level);
      expect(parseLogLevel(level.toUpperCase())).toBe(level);
      expect(parseLogLevel(`  ${level}  `)).toBe(level);
    }
  });

  it("falls back on an unrecognized value and warns exactly once per process, to stderr only", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(parseLogLevel("verbose")).toBe("info");
      expect(parseLogLevel("loud", "silent")).toBe("silent");
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0]?.[0])).toContain('unrecognized FICTA_LOG_LEVEL "verbose"');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });
});

describe("levelEnabled", () => {
  it("emits a tag when the configured level is at or above it", () => {
    expect(levelEnabled("info", "info")).toBe(true);
    expect(levelEnabled("debug", "info")).toBe(true);
    expect(levelEnabled("trace", "warn")).toBe(true);
    expect(levelEnabled("info", "debug")).toBe(false);
    expect(levelEnabled("silent", "error")).toBe(false);
    expect(levelEnabled("warn", "error")).toBe(true);
    expect(levelEnabled("error", "warn")).toBe(false);
  });

  it("silent emits nothing above itself and trace emits everything", () => {
    for (const at of LOG_LEVELS) {
      expect(levelEnabled("silent", at)).toBe(at === "silent");
      expect(levelEnabled("trace", at)).toBe(true);
    }
  });
});
