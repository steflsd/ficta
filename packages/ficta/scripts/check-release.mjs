#!/usr/bin/env node
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const version = String(pkg.version);
const changelog = readFileSync(new URL("CHANGELOG.md", root), "utf8");
const heading = new RegExp(`^##\\s+${escapeRegExp(version)}(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m");

if (!heading.test(changelog)) {
  console.error(`release check failed: CHANGELOG.md has no section for package version ${version}`);
  console.error("run `pnpm release:beta` or add the matching changelog heading before publishing");
  process.exit(1);
}

console.error(`release check ok: CHANGELOG.md documents ${version}`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
