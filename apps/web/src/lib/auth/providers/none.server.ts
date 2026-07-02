import { type AuthProvider, redirectResponse } from "../provider.server";
import type { AuthState } from "../types";

/**
 * The default, self-hosted provider: no auth at all. The app is fully open and every surface behaves
 * exactly as it did before auth existed. Sign-in/callback/sign-out routes still exist but are inert —
 * they just bounce back to `/` — so the routing surface is identical whether or not auth is enabled.
 */
export function createProvider(): AuthProvider {
  const state: AuthState = { provider: "none", requiresAuth: false, user: null };
  return {
    name: "none",
    requiresAuth: false,
    async getAuthState() {
      return state;
    },
    async getSignInUrl() {
      return "/";
    },
    async handleCallback() {
      return redirectResponse("/");
    },
    async signOut(returnTo) {
      return redirectResponse(returnTo ?? "/");
    },
    async getAccessToken() {
      return null;
    },
    async listOrganizations() {
      return [];
    },
    async createOrganization() {
      throw new Error("organizations are not available");
    },
    async switchOrganization() {
      // No organizations in `none` mode; nothing to switch.
    },
  };
}
