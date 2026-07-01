#!/usr/bin/env node
/**
 * Prepare a ficta release locally.
 *
 * Usage:
 *   node scripts/release.mjs beta [preid]
 *   node scripts/release.mjs stable
 *   node scripts/release.mjs patch|minor|major
 *   node scripts/release.mjs x.y.z[-pre.n]
 *
 * Steps:
 * 1. Require a clean working tree
 * 2. Bump package.json
 * 3. Promote CHANGELOG.md Unreleased notes to the new version/date
 * 4. Run verify/build/release checks
 * 5. Commit and tag the release
 * 6. Add a fresh Unreleased section for the next cycle
 * 7. Commit the next-cycle changelog
 *
 * Push main and the tag afterwards to trigger CI publishing.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RELEASE_TARGET = process.argv[2];
const PREID = process.argv[3] ?? "beta";
const BUMP_TYPES = new Set(["beta", "prerelease", "stable", "release", "patch", "minor", "major"]);
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET))) {
  console.error("Usage: node scripts/release.mjs <beta|prerelease|stable|patch|minor|major|x.y.z[-pre.n]> [preid]");
  process.exit(1);
}

function run(command, options = {}) {
  console.log(`$ ${command}`);
  try {
    return execSync(command, { encoding: "utf8", stdio: options.silent ? "pipe" : "inherit", ...options });
  } catch {
    console.error(`Command failed: ${command}`);
    process.exit(1);
  }
}

function readPackageJson() {
  return JSON.parse(readFileSync("package.json", "utf8"));
}

function writePackageJson(pkg) {
  writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
}

function currentVersion() {
  return String(readPackageJson().version);
}

function setVersion(version) {
  const pkg = readPackageJson();
  pkg.version = version;
  writePackageJson(pkg);
}

function nextSemver(version, target, preid) {
  if (SEMVER_RE.test(target)) {
    if (compareSemver(target, version) <= 0)
      fail(`explicit version ${target} must be greater than current version ${version}`);
    return target;
  }

  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) fail(`package.json version is not a supported semver: ${version}`);

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  const prerelease = match[4];

  switch (target) {
    case "beta":
    case "prerelease": {
      if (prerelease) {
        const parts = prerelease.split(".");
        const currentPreid = parts.slice(0, -1).join(".");
        const n = Number(parts.at(-1));
        if (currentPreid === preid && Number.isInteger(n) && n >= 0)
          return `${major}.${minor}.${patch}-${preid}.${n + 1}`;
        return `${major}.${minor}.${patch}-${preid}.0`;
      }
      return `${major}.${minor}.${patch + 1}-${preid}.0`;
    }
    case "stable":
    case "release":
      if (!prerelease) fail(`package.json version ${version} is already stable; use patch/minor/major instead`);
      return `${major}.${minor}.${patch}`;
    case "patch":
      if (!prerelease) patch += 1;
      return `${major}.${minor}.${patch}`;
    case "minor":
      minor += 1;
      patch = 0;
      return `${major}.${minor}.${patch}`;
    case "major":
      major += 1;
      minor = 0;
      patch = 0;
      return `${major}.${minor}.${patch}`;
    default:
      fail(`unknown release target: ${target}`);
  }
}

function compareSemver(a, b) {
  const parsedA = parseComparableSemver(a);
  const parsedB = parseComparableSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = parsedA.core[i] - parsedB.core[i];
    if (diff !== 0) return diff;
  }
  if (!parsedA.pre && parsedB.pre) return 1;
  if (parsedA.pre && !parsedB.pre) return -1;
  if (!parsedA.pre && !parsedB.pre) return 0;
  return parsedA.pre.localeCompare(parsedB.pre, undefined, { numeric: true });
}

function parseComparableSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) fail(`invalid semver: ${version}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" };
}

function assertNoTag(version) {
  try {
    execSync(`git rev-parse -q --verify ${shellEscape(`refs/tags/v${version}`)}`, { encoding: "utf8", stdio: "pipe" });
  } catch {
    return;
  }
  fail(`tag v${version} already exists`);
}

function promoteChangelog(version) {
  const text = readFileSync("CHANGELOG.md", "utf8");
  const existingVersion = new RegExp(`^##\\s+${escapeRegExp(version)}(?:\\s|$)`, "m");
  if (existingVersion.test(text)) fail(`CHANGELOG.md already has a section for ${version}`);

  const heading = /^## Unreleased\s*$/m.exec(text);
  if (!heading) fail("CHANGELOG.md must contain a `## Unreleased` section");

  const bodyStart = heading.index + heading[0].length;
  const rest = text.slice(bodyStart);
  const nextHeading = /\n##\s+/.exec(rest);
  const bodyEnd = nextHeading ? bodyStart + nextHeading.index : text.length;
  const body = text.slice(bodyStart, bodyEnd).trim();
  if (!body) fail("CHANGELOG.md `## Unreleased` is empty; add release notes before releasing");

  const date = new Date().toISOString().slice(0, 10);
  const before = text.slice(0, heading.index);
  const after = text.slice(bodyEnd).replace(/^\n?/, "\n");
  writeFileSync("CHANGELOG.md", `${before}## ${version} - ${date}\n\n${body}\n${after}`);
}

function addFreshUnreleasedSection() {
  const text = readFileSync("CHANGELOG.md", "utf8");
  if (/^## Unreleased\s*$/m.test(text)) fail("CHANGELOG.md already has an Unreleased section");
  const updated = text.replace(/^(# Changelog\n\n)/, "$1## Unreleased\n\n");
  if (updated === text) fail("CHANGELOG.md must start with `# Changelog` followed by a blank line");
  writeFileSync("CHANGELOG.md", updated);
}

function shellEscape(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  console.error(`release failed: ${message}`);
  process.exit(1);
}

console.log("\n=== ficta release ===\n");

const status = run("git status --porcelain", { silent: true });
if (status.trim()) fail(`working tree is not clean:\n${status}`);

const previousVersion = currentVersion();
const version = nextSemver(previousVersion, RELEASE_TARGET, PREID);
assertNoTag(version);

console.log(`Preparing ${previousVersion} -> ${version}\n`);
setVersion(version);
promoteChangelog(version);

run("pnpm verify");
run("pnpm build");
run("pnpm release:check");

run("git add package.json CHANGELOG.md");
run(`git commit -m ${shellEscape(`chore: release v${version}`)}`);
run(`git tag ${shellEscape(`v${version}`)}`);

addFreshUnreleasedSection();
run("git add CHANGELOG.md");
run(`git commit -m ${shellEscape("chore: start next release notes")}`);

console.log(`\n=== prepared v${version} ===\n`);
console.log("Review the release commits, then publish by pushing main and the tag:");
console.log("  git push origin main");
console.log(`  git push origin v${version}`);
