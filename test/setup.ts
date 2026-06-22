// Keep tests deterministic and isolated from any real ~/.ficta/config.toml or Doppler CLI/config.
// Doppler-specific tests opt in with a fake CLI via FICTA_REGISTRY_DOPPLER_ENABLED=1.
process.env.FICTA_CONFIG_FILE = "0";
process.env.FICTA_REGISTRY_DOPPLER_ENABLED = "0";
process.env.FICTA_REGISTRY_DOPPLER_CONFIGS = "current";
process.env.FICTA_REGISTRY_ENV_FILE_ENABLED = "1";
process.env.FICTA_REGISTRY_ENV_FILE_PATHS = ".env:.env.local";
process.env.FICTA_REGISTRY_PROCESS_ENV_ENABLED = "0";
process.env.FICTA_REGISTRY_PROCESS_ENV_MODE = "secret-ish";
