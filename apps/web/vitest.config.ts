import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Minimal vitest config for apps/web. We deliberately do NOT load the TanStack Start / React / Tailwind
 * plugins — the storage suite is plain server code. The `@` alias mirrors vite.config.ts so `@/…` imports
 * resolve, and `import.meta.glob` (used by the migration applier) is a core Vite feature vitest supports.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
