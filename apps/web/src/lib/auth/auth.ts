import { createServerFn } from "@tanstack/react-start";
import { getActiveProvider } from "./provider.server";
import type { AuthState, OrgSummary } from "./types";

/**
 * Reads the current request's auth state on the server and hands back plain, serializable `AuthState`.
 * The root route's `beforeLoad` calls this to gate the app and seed router context; wrapping it in a
 * server function (rather than calling the provider directly in beforeLoad) is what lets WorkOS's
 * request-scoped `getAuth()` run — beforeLoad also executes on the client during hydration, where the
 * provider SDK must never run. The server-fn boundary keeps the WorkOS import server-only.
 */
export const fetchAuthState = createServerFn({ method: "GET" }).handler(async (): Promise<AuthState> => {
  const provider = await getActiveProvider();
  return provider.getAuthState();
});

/** The organizations (workspaces) the current user can switch between. Empty unless WorkOS has memberships. */
export const fetchOrganizations = createServerFn({ method: "GET" }).handler(async (): Promise<OrgSummary[]> => {
  const provider = await getActiveProvider();
  return provider.listOrganizations();
});

/**
 * Switch the active workspace, then let the caller reload. The target is validated against the user's own
 * memberships server-side — a client can't switch into an org it doesn't belong to by posting an arbitrary id.
 */
export const switchOrganization = createServerFn({ method: "POST" })
  .validator((data: { organizationId: string }) => {
    if (!data || typeof data.organizationId !== "string" || !data.organizationId) {
      throw new Error("organizationId is required");
    }
    return data;
  })
  .handler(async ({ data }): Promise<void> => {
    const provider = await getActiveProvider();
    const allowed = await provider.listOrganizations();
    if (!allowed.some((org) => org.id === data.organizationId)) throw new Error("forbidden");
    await provider.switchOrganization(data.organizationId);
  });

/** Create a new workspace and switch the current session into it. */
export const createOrganization = createServerFn({ method: "POST" })
  .validator((data: { name: string }) => {
    if (!data || typeof data.name !== "string") throw new Error("name is required");
    const name = data.name.trim();
    if (!name) throw new Error("name is required");
    if (name.length > 100) throw new Error("name must be 100 characters or fewer");
    return { name };
  })
  .handler(async ({ data }): Promise<OrgSummary> => {
    const provider = await getActiveProvider();
    return provider.createOrganization(data.name);
  });
