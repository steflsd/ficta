import { getActiveProvider } from "./provider.server";
import { type AuthState, isAdmin } from "./types";

/**
 * Server-side identity guards for server functions. Every storage-touching server function re-derives the
 * caller's identity through these rather than trusting client input — the client never sends a userId, so
 * a user can only read/write their own rows and only an admin can write instance settings. This is the
 * real enforcement; route `beforeLoad` gating is just UX.
 */

/** The current request's auth state (server-only; runs the provider SDK). */
export async function requireAuthState(): Promise<AuthState> {
  return (await getActiveProvider()).getAuthState();
}

export interface Scope {
  userId: string;
  orgId: string;
}

/**
 * The scope keys for storage: `userId` owns per-user rows, `orgId` is the tenant (workspace) rows are
 * partitioned by. Both are opaque strings.
 *
 * - `none` mode → a single implicit user in a single workspace: both are the `"local"` sentinel.
 * - WorkOS with an active organization → `{ user.id, user.organizationId }`.
 * - WorkOS with no active organization → a defensive personal fallback during onboarding: `orgId` is
 *   `"user:<userId>"`.
 * - unauthenticated under a real provider → `null`.
 */
export function scopeFromAuth(auth: AuthState): Scope | null {
  if (auth.user) return { userId: auth.user.id, orgId: auth.user.organizationId ?? `user:${auth.user.id}` };
  if (auth.provider === "none") return { userId: "local", orgId: "local" };
  return null;
}

/** The current scope, or `null` for an unauthenticated request under a real provider (no throw). */
export async function optionalScope(): Promise<Scope | null> {
  return scopeFromAuth(await requireAuthState());
}

/** The current scope; rejects an unauthenticated request under a real provider. */
export async function requireScope(): Promise<Scope> {
  const scope = scopeFromAuth(await requireAuthState());
  if (!scope) throw new Error("unauthorized");
  return scope;
}

/** The scoping id for per-user storage. See {@link requireScope}. */
export async function requireUserId(): Promise<string> {
  return (await requireScope()).userId;
}

/** Asserts the caller may edit instance-wide settings; returns the auth state for convenience. */
export async function requireAdmin(): Promise<AuthState> {
  const auth = await requireAuthState();
  if (!isAdmin(auth)) throw new Error("forbidden");
  return auth;
}

/** Admin check plus the current workspace scope, for instance-settings writes. */
export async function requireAdminScope(): Promise<Scope> {
  const auth = await requireAuthState();
  if (!isAdmin(auth)) throw new Error("forbidden");
  const scope = scopeFromAuth(auth);
  if (!scope) throw new Error("unauthorized");
  return scope;
}
