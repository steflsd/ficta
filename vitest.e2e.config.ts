import { defineConfig } from "vitest/config";

// Live, real-agent end-to-end suite. Opt-in only via `pnpm test:e2e`.
// Spawns the real claude/codex/pi binaries through ficta against the real
// providers, so turns are slow and rate-limited — long timeouts, no parallelism.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    setupFiles: ["test/setup.ts", "test/e2e/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
