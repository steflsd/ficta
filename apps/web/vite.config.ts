import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Load apps/web/.env (all keys, no VITE_ prefix) into the *server* process, so the /api/chat
  // handler can read OPENAI_API_KEY / ANTHROPIC_API_KEY / FICTA_PROXY_URL via process.env. A real
  // shell export still wins. These never enter the client bundle — only server-only code reads them.
  const fileEnv = loadEnv(mode, process.cwd(), "");
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    // 4747 is deliberately uncommon: WORKOS_REDIRECT_URI is registered statically in the WorkOS
    // dashboard, so the port must never drift. strictPort fails loudly instead of falling back.
    server: { port: 4747, strictPort: true },
    resolve: {
      // `@` → src, so shadcn/ui-generated imports (`@/components/...`, `@/lib/utils`) resolve.
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    plugins: [
      tanstackStart(),
      // React's Vite plugin must come after TanStack Start's plugin.
      viteReact(),
      // Tailwind v4 scans classes and emits CSS; runs last.
      tailwindcss(),
    ],
  };
});
