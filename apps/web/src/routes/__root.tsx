import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Outlet, redirect, Scripts } from "@tanstack/react-router";
import { fetchAuthState } from "@/lib/auth/auth";
import { getQueryClient } from "@/lib/query-client";
import { fetchInstanceSettings } from "@/lib/storage/settings";
import styles from "@/styles.css?url";

export const Route = createRootRoute({
  // Resolve auth once at the top of the tree: gate the whole app when the provider requires it, and
  // seed router context so any component can read the current user (see useAuthState). In `none` mode
  // this returns an open state and never redirects. `/api/auth/*` are server routes and don't run this,
  // so the redirect target can't loop.
  beforeLoad: async ({ location }) => {
    // Resolve auth first and gate before doing anything else — an unauthenticated user shouldn't trigger
    // instance-settings work. Both land in router context so components read them without refetching.
    const auth = await fetchAuthState();
    if (auth.requiresAuth && !auth.user) {
      const returnPathname = encodeURIComponent(location.pathname + location.searchStr);
      throw redirect({ href: `/api/auth/sign-in?returnPathname=${returnPathname}` });
    }
    if (auth.user && !auth.user.organizationId && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" });
    }
    if (auth.user?.organizationId && location.pathname === "/onboarding") {
      throw redirect({ to: "/" });
    }
    const instance = await fetchInstanceSettings();
    return { auth, instance };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ficta chat" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  component: RootDocument,
});

// Set the theme before first paint to avoid a flash: honor a saved choice, else follow the OS.
const THEME_INIT = `(()=>{try{const t=localStorage.getItem("ficta-theme");const dark=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",dark);}catch{}})()`;

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, self-authored theme bootstrap */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <HeadContent />
      </head>
      <body>
        <QueryClientProvider client={getQueryClient()}>
          <Outlet />
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
