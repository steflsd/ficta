import { useRouteContext } from "@tanstack/react-router";
import type { AuthState } from "./types";

const FALLBACK: AuthState = { provider: "none", requiresAuth: false, user: null };

/**
 * Read the auth state that the root route's `beforeLoad` placed in router context. Client-only and
 * SDK-free — components get the identity without importing any provider code. Falls back to an open
 * `none` state if context is somehow unset, so the UI degrades to "no user" rather than throwing.
 */
export function useAuthState(): AuthState {
  return useRouteContext({
    from: "__root__",
    select: (ctx) => (ctx as { auth?: AuthState }).auth ?? FALLBACK,
  });
}
