import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The live, real-agent e2e suite is opt-in only — run it via `pnpm test:e2e`
    // (vitest.e2e.config.ts). It must never run in the default offline suite/CI.
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    environment: "node",
    setupFiles: ["test/setup.ts"],
  },
});
