import type { AuthProviderName, AuthState, OrgSummary } from "./types";

/**
 * The auth boundary seam. Everything auth-related in apps/web goes through an `AuthProvider`, so the
 * hosted provider (WorkOS today, Clerk later) is one file behind this interface and the rest of the app
 * — routes, the chat guard, the header — never imports a provider SDK directly.
 *
 * Request middleware is intentionally NOT on this interface: it must be registered on the TanStack Start
 * instance at module load (see src/start.ts), which is a different lifecycle than these per-request
 * calls. start.ts switches middleware on the same `AUTH_PROVIDER` env var this resolver reads.
 *
 * This module is server-only: it (dynamically) loads provider code that reads request context and
 * secrets. It is only ever imported from server boundaries (server routes, the fetchAuthState server
 * function, start.ts) — never from a React component, which reads plain `AuthState` from router context.
 */
export interface AuthProvider {
  readonly name: AuthProviderName;
  /** Whether unauthenticated users must be redirected to sign in. `false` for the `none` provider. */
  readonly requiresAuth: boolean;
  /** Resolve the current request's identity. Cheap/static for `none`; reads the session for WorkOS. */
  getAuthState(): Promise<AuthState>;
  /** Provider sign-in URL to redirect to; `returnPathname` is where to land after auth. */
  getSignInUrl(returnPathname?: string): Promise<string>;
  /** Handle the OAuth redirect back from the provider (exchange code, set session cookie). */
  handleCallback(request: Request): Promise<Response>;
  /** Clear the session and return a redirect Response. */
  signOut(returnTo?: string): Promise<Response>;
  /** The current session's access token (JWT), for future Convex `ConvexProviderWithAuth` plumbing. */
  getAccessToken(): Promise<string | null>;
  /** Organizations (tenants) the current user belongs to. Empty for `none` and org-less users with no memberships. */
  listOrganizations(): Promise<OrgSummary[]>;
  /** Create an organization, make the current user its admin, switch the session into it, and return it. */
  createOrganization(name: string): Promise<OrgSummary>;
  /** Refresh the session onto `organizationId` (new role/permission claims). No-op for `none`. */
  switchOrganization(organizationId: string): Promise<void>;
}

let cached: Promise<AuthProvider> | null = null;

/**
 * Resolve the configured provider once per server process. The dynamic import means the WorkOS SDK is
 * only ever loaded when `AUTH_PROVIDER=workos`; self-hosted `none` installs never touch it at runtime.
 */
export function getActiveProvider(): Promise<AuthProvider> {
  if (cached) return cached;
  const name: AuthProviderName = process.env.AUTH_PROVIDER === "workos" ? "workos" : "none";
  cached =
    name === "workos"
      ? import("./providers/workos.server").then((m) => m.createProvider())
      : import("./providers/none.server").then((m) => m.createProvider());
  return cached;
}

/** A 307 redirect Response — the shared shape providers return from sign-out/callback fallbacks. */
export function redirectResponse(location: string): Response {
  return new Response(null, { status: 307, headers: { Location: location } });
}
