import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globalDisablePath, isGloballyDisabled, setGlobalDisabled } from "../src/global-disable.js";

describe("global disable", () => {
  it("persists and clears a global disabled flag", () => {
    const home = mkdtempSync(join(tmpdir(), "ficta-disable-home-"));
    const path = globalDisablePath(home);

    expect(isGloballyDisabled(home)).toBe(false);

    const disabled = setGlobalDisabled(true, home);
    expect(disabled).toEqual({ path, disabled: true, changed: true });
    expect(isGloballyDisabled(home)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("ficta enable");

    const disabledAgain = setGlobalDisabled(true, home);
    expect(disabledAgain).toEqual({ path, disabled: true, changed: false });

    const enabled = setGlobalDisabled(false, home);
    expect(enabled).toEqual({ path, disabled: false, changed: true });
    expect(existsSync(path)).toBe(false);
    expect(isGloballyDisabled(home)).toBe(false);
  });
});
