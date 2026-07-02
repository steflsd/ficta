import { createFileRoute } from "@tanstack/react-router";
import { getActiveProvider } from "@/lib/auth/provider.server";

/**
 * The OAuth redirect target. Must match `WORKOS_REDIRECT_URI` (default
 * http://localhost:4747/api/auth/callback). The provider exchanges the code, sets the session cookie,
 * and redirects to the flow's returnPathname. In `none` mode it just redirects to `/`.
 */
export const Route = createFileRoute("/api/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const provider = await getActiveProvider();
        return provider.handleCallback(request);
      },
    },
  },
});
