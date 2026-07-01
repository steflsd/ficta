// Loaded ONLY by vitest.e2e.config.ts (the `pnpm test:e2e` entry point).
// Opting into the live suite is implied by deliberately running that config, so
// default FICTA_E2E on here. The default offline suite never loads this file.
process.env.FICTA_E2E ??= "1";
