/**
 * Client-safe auth types. This module is import-only-for-types on the client — it pulls in no provider
 * SDK, so React components and the router can share the identity shape without bundling WorkOS/Clerk.
 *
 * `AuthUser` is deliberately provider-neutral and doubles as the future Convex sync key: `id` is the
 * provider's stable user id (WorkOS "user_...") and `organizationId` its tenant, so a later Convex
 * `users` table can key off these without a shape change.
 */

export type AuthProviderName = "none" | "workos";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  organizationId?: string;
  /** Session role claims from the provider (WorkOS). Used only for `isAdmin`; empty for `none`. */
  role?: string;
  roles?: string[];
  permissions?: string[];
}

export interface AuthState {
  provider: AuthProviderName;
  /** When false (self-hosted `none` mode) the app is fully open and behaves exactly as before auth. */
  requiresAuth: boolean;
  user: AuthUser | null;
}

/** One organization (tenant) a user belongs to. Client-safe — backs the workspace switcher. */
export interface OrgSummary {
  id: string;
  name: string;
}

/**
 * Whether the current session may edit the current workspace's (admin) settings. Client-safe and used in
 * two places: route `beforeLoad` (a UX gate — hide/redirect) and the server functions themselves (the
 * real gate).
 *
 * In `none` mode there is a single implicit owner, so everyone is admin. Under a real provider with an
 * active organization, admin is a role claim (default-deny: no role assigned is not admin). A WorkOS user
 * with no active organization is routed to onboarding; during that defensive window, they are treated as
 * admin for the personal-workspace fallback only.
 */
export function isAdmin(auth: AuthState): boolean {
  if (auth.provider === "none") return true;
  const user = auth.user;
  if (!user) return false;
  if (!user.organizationId) return true;
  return user.role === "admin" || user.roles?.includes("admin") === true;
}
