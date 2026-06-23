import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultFictaHome } from "./install.js";

const DISABLE_FILE = "disabled";

export interface GlobalDisableResult {
  path: string;
  disabled: boolean;
  changed: boolean;
}

export function globalDisablePath(home = homedir()): string {
  return join(defaultFictaHome(home), DISABLE_FILE);
}

export function isGloballyDisabled(home = homedir()): boolean {
  return existsSync(globalDisablePath(home));
}

export function setGlobalDisabled(disabled: boolean, home = homedir()): GlobalDisableResult {
  const path = globalDisablePath(home);
  const exists = existsSync(path);

  if (disabled) {
    if (!exists) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `# ficta global disable\n# Remove this file or run \`ficta enable\` to re-enable shims.\n`, {
        mode: 0o600,
      });
      try {
        chmodSync(dirname(path), 0o700);
        chmodSync(path, 0o600);
      } catch {
        // Best-effort on filesystems that do not support POSIX modes.
      }
    }
    return { path, disabled: true, changed: !exists };
  }

  if (exists) unlinkSync(path);
  return { path, disabled: false, changed: exists };
}
