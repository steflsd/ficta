import { afterEach, describe, expect, it, vi } from "vitest";

const originalLogLevel = process.env.FICTA_LOG_LEVEL;

afterEach(() => {
  if (originalLogLevel === undefined) delete process.env.FICTA_LOG_LEVEL;
  else process.env.FICTA_LOG_LEVEL = originalLogLevel;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("proxy logger", () => {
  it("reads FICTA_LOG_LEVEL lazily on the first log call, not at import time", async () => {
    delete process.env.FICTA_LOG_LEVEL;
    vi.resetModules();
    const { log } = await import("../src/logger.js");

    process.env.FICTA_LOG_LEVEL = "silent";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    log.info("FICTA_SHOULD_NOT_APPEAR");

    expect(stderr).not.toHaveBeenCalled();
  });
});
