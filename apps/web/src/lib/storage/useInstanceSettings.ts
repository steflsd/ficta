import { useRouteContext } from "@tanstack/react-router";
import type { InstanceSettings } from "./types";

const FALLBACK: InstanceSettings = {};

/**
 * Read the instance settings the root route's `beforeLoad` placed in router context. Client-safe (pulls in
 * no server code) and the mirror of `useAuthState` — components get instance config (name, allowed models)
 * without a refetch. Falls back to an empty object (no restrictions, default name) if context is unset.
 */
export function useInstanceSettings(): InstanceSettings {
  return useRouteContext({
    from: "__root__",
    select: (ctx) => (ctx as { instance?: InstanceSettings }).instance ?? FALLBACK,
  });
}
