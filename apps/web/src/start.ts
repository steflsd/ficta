import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

/**
 * The TanStack Start instance. It exists chiefly to register request middleware for auth, and it is
 * server-only — nothing here reaches the client bundle.
 *
 * Two things to know:
 *
 * 1. CSRF: defining a custom Start instance opts out of the framework's *default* server-function CSRF
 *    protection, so we re-add it explicitly via `createCsrfMiddleware` (a framework primitive, always
 *    on, in every mode). The filter scopes it to server-function calls, matching the default behavior.
 *
 * 2. Auth: `authkitMiddleware()` (which reads/refreshes the WorkOS session cookie on every request) is
 *    only registered when `AUTH_PROVIDER=workos`. In the default `none` mode it is never imported or
 *    called, so self-hosted installs get identical behavior to before auth existed. The WorkOS import
 *    is dynamic and gated so its module isn't even loaded unless hosted auth is turned on. Adding a
 *    second hosted provider (e.g. Clerk) later is one more branch here plus one provider file.
 */
async function buildRequestMiddleware() {
  const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });
  // `import.meta.env.SSR` is a compile-time constant — statically false in the client build — so the
  // whole WorkOS branch (and its dynamic import) is dead-code-eliminated from the client bundle. The
  // Start instance is isomorphic; without this guard the runtime-only `AUTH_PROVIDER` check would leave
  // a stub authkit chunk on the client. On the server it's a boot-time env check.
  if (import.meta.env.SSR && process.env.AUTH_PROVIDER === "workos") {
    const { authkitMiddleware } = await import("@workos/authkit-tanstack-react-start");
    return [csrf, authkitMiddleware()];
  }
  return [csrf];
}

export const startInstance = createStart(async () => ({
  requestMiddleware: await buildRequestMiddleware(),
}));
