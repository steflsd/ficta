import { createFileRoute } from "@tanstack/react-router";
import { getActiveProvider, redirectResponse } from "@/lib/auth/provider.server";

/**
 * Kicks off the hosted sign-in flow. PKCE requires the flow to *start* here (the provider sets a
 * per-flow verifier cookie), so the root route's gate redirects unauthenticated users to this route
 * rather than straight to the provider. `?returnPathname=` is where the user lands after auth.
 *
 * In `none` mode the provider's sign-in URL is just `/`, so this harmlessly bounces home.
 */
export const Route = createFileRoute("/api/auth/sign-in")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const provider = await getActiveProvider();
        const returnPathname = new URL(request.url).searchParams.get("returnPathname") ?? undefined;
        const url = await provider.getSignInUrl(returnPathname);
        return redirectResponse(url);
      },
    },
  },
});
