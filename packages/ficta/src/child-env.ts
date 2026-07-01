const INTERNAL_CHILD_ENV_DENYLIST = new Set([
  // Used only by the local proxy to derive/restore surrogates. The coding agent never needs it,
  // and if the agent prints its environment this value could otherwise be sent to the model.
  "FICTA_SURROGATE_KEY",
]);

/** Environment passed to child agents. Keeps normal auth/config, drops proxy-internal secrets. */
export function sanitizeAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of INTERNAL_CHILD_ENV_DENYLIST) delete out[key];
  return out;
}
