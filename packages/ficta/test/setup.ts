// Keep tests deterministic and isolated from any real ~/.ficta/config.toml, Doppler CLI/config, or a
// shell that has sourced the ficta dev environment. vitest inherits the launching process's env (it
// does not sandbox process.env), so a dev shell exporting e.g. FICTA_PII_BACKEND=presidio or
// FICTA_LOG_LEVEL=silent would otherwise leak in and flip detection/logging behavior mid-suite. Wipe
// the whole FICTA_ namespace to a clean, CI-equivalent baseline first, then set only what the offline
// suite needs; individual tests still opt into specific vars (e.g. Doppler tests set
// FICTA_REGISTRY_DOPPLER_ENABLED=1, backend tests set FICTA_PII_BACKEND) and save/restore around them.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("FICTA_")) delete process.env[key];
}

process.env.FICTA_CONFIG_FILE = "0";
process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
process.env.FICTA_REGISTRY_DOPPLER_CONFIGS = "current";
process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
process.env.FICTA_REGISTRY_ENV_FILE_PATHS = ".env:.env.local";
process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
process.env.FICTA_REGISTRY_PROCESS_ENV_MODE = "secret-ish";
