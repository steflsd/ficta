import { createFileRoute } from "@tanstack/react-router";
import { getActiveProvider } from "@/lib/auth/provider.server";

/**
 * Clears the session and redirects. Accepts GET so the header's user menu can trigger it with a
 * top-level navigation. In `none` mode it simply redirects home.
 */
export const Route = createFileRoute("/api/auth/sign-out")({
  server: {
    handlers: {
      GET: async () => {
        const provider = await getActiveProvider();
        return provider.signOut("/");
      },
    },
  },
});
