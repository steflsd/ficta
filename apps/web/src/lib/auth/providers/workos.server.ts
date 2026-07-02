import {
  getAuth,
  handleCallbackRoute,
  getSignInUrl as workosGetSignInUrl,
  signOut as workosSignOut,
  switchToOrganization as workosSwitchToOrganization,
} from "@workos/authkit-tanstack-react-start";
import { WorkOS } from "@workos-inc/node";
import { type AuthProvider, redirectResponse } from "../provider.server";
import type { AuthState, AuthUser, OrgSummary } from "../types";

/**
 * The WorkOS AuthKit provider — the ONLY module in apps/web that imports the WorkOS SDK. The session
 * itself is read/refreshed by `authkitMiddleware()` (registered in src/start.ts); these helpers just
 * read the request-scoped result. Enabled with `AUTH_PROVIDER=workos` plus the WORKOS_* env vars.
 *
 * `@workos/authkit-tanstack-react-start` is pre-1.0; we read its results through a narrow local shape
 * (below) rather than its exported types so a minor SDK churn can't break our typecheck. When wiring a
 * live WorkOS tenant, confirm the callback/sign-out helpers against the installed SDK version.
 */

// The subset of WorkOS's UserInfo we consume. `getAuth()` returns UserInfo | NoUserInfo; the latter has
// `user: null`, so optional fields collapse cleanly.
interface WorkosAuth {
  user: {
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    profilePictureUrl?: string | null;
  } | null;
  organizationId?: string | null;
  accessToken?: string | null;
  // Role/permission claims live on the AuthKit result alongside `user` (verified against the installed
  // SDK's UserInfo). `role` is the active org membership's single role; `roles` its list form.
  role?: string | null;
  roles?: string[] | null;
  permissions?: string[] | null;
}

// A direct WorkOS API client (distinct from the AuthKit session helpers) — needed to list a user's
// organization memberships, which the AuthKit SDK doesn't expose. Memoized per process; reads WORKOS_API_KEY.
let apiClient: WorkOS | null = null;
function getApiClient(): WorkOS {
  if (!apiClient) {
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) throw new Error("WORKOS_API_KEY is not set");
    apiClient = new WorkOS(apiKey);
  }
  return apiClient;
}

function toAuthUser(auth: WorkosAuth): AuthUser | null {
  if (!auth.user) return null;
  const name = [auth.user.firstName, auth.user.lastName].filter(Boolean).join(" ").trim();
  return {
    id: auth.user.id,
    email: auth.user.email,
    name: name || undefined,
    avatarUrl: auth.user.profilePictureUrl ?? undefined,
    organizationId: auth.organizationId ?? undefined,
    role: auth.role ?? undefined,
    roles: auth.roles ?? undefined,
    permissions: auth.permissions ?? undefined,
  };
}

export function createProvider(): AuthProvider {
  return {
    name: "workos",
    requiresAuth: true,
    async getAuthState(): Promise<AuthState> {
      const auth = (await getAuth()) as WorkosAuth;
      return { provider: "workos", requiresAuth: true, user: toAuthUser(auth) };
    },
    async getSignInUrl(returnPathname?: string): Promise<string> {
      return workosGetSignInUrl(returnPathname ? { data: { returnPathname } } : undefined);
    },
    async handleCallback(request: Request): Promise<Response> {
      // handleCallbackRoute() returns a TanStack server-route handler; it exchanges the code and sets
      // the session cookie, then redirects to the flow's returnPathname.
      const handler = handleCallbackRoute();
      return handler({ request } as Parameters<typeof handler>[0]);
    },
    async signOut(returnTo?: string): Promise<Response> {
      // Clears the WorkOS session. The SDK helper performs its own redirect to the WorkOS logout URL;
      // if it returns control instead, fall back to a local redirect so the caller always gets a Response.
      await workosSignOut(returnTo ? { data: { returnTo } } : undefined);
      return redirectResponse(returnTo ?? "/");
    },
    async getAccessToken(): Promise<string | null> {
      const auth = (await getAuth()) as WorkosAuth;
      return auth.accessToken ?? null;
    },
    async listOrganizations(): Promise<OrgSummary[]> {
      const auth = (await getAuth()) as WorkosAuth;
      if (!auth.user) return [];
      // `organizationName` rides along on each membership, so no per-org lookup is needed. limit:100 covers
      // any realistic number of memberships in one call (the default page size is 10).
      const memberships = await getApiClient().userManagement.listOrganizationMemberships({
        userId: auth.user.id,
        statuses: ["active"],
        limit: 100,
      });
      return memberships.data.map((m) => ({ id: m.organizationId, name: m.organizationName }));
    },
    async createOrganization(name: string): Promise<OrgSummary> {
      const auth = (await getAuth()) as WorkosAuth;
      if (!auth.user) throw new Error("unauthorized");

      const client = getApiClient();
      const org = await client.organizations.createOrganization({ name });
      await client.userManagement.createOrganizationMembership({
        organizationId: org.id,
        userId: auth.user.id,
        roleSlug: "admin",
      });
      await workosSwitchToOrganization({ data: { organizationId: org.id } });
      return { id: org.id, name: org.name };
    },
    async switchOrganization(organizationId: string): Promise<void> {
      // Refreshes the session cookie with the target org's role/permission claims. The updated claims are
      // read back on the next request via getAuth().
      await workosSwitchToOrganization({ data: { organizationId } });
    },
  };
}
