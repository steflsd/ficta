#!/usr/bin/env node
/** Publish the single ficta npm package, idempotently. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
// The publish itself authenticates via trusted publishing (OIDC), which does not authorize a
// follow-up `npm dist-tag add`. In CI the two are split into separate steps so the dist-tag write
// can carry its own automation token: the publish step passes --skip-advance-latest, and a
// dedicated token-authed step passes --advance-latest-only. With no flags (local publish) both run.
const advanceLatestOnly = process.argv.includes("--advance-latest-only");
const skipAdvanceLatest = process.argv.includes("--skip-advance-latest");
const KNOWN_FLAGS = new Set(["--dry-run", "--advance-latest-only", "--skip-advance-latest"]);
const unknownArgs = process.argv.slice(2).filter((arg) => !KNOWN_FLAGS.has(arg));
if (unknownArgs.length > 0 || (advanceLatestOnly && skipAdvanceLatest)) {
  console.error("Usage: node scripts/publish.mjs [--dry-run] [--advance-latest-only | --skip-advance-latest]");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const name = String(pkg.name);
const version = String(pkg.version);
const expectedTag = process.env.RELEASE_TAG;
const distTag = npmDistTag(version);

assertPackageMetadata();
assertTagMatchesVersion(expectedTag, version);

if (advanceLatestOnly) {
  // Dedicated dist-tag step: the package is already published, so skip the publish preconditions.
  advanceLatestForBetaPhase(name, version, distTag);
  process.exit(0);
}

assertChangelogHasVersion(version);
assertBuildOutputExists();

console.log(`Publishing ${name}@${version} with dist-tag ${distTag}${dryRun ? " (dry run)" : ""}\n`);

const published = isPublished(name, version);
if (dryRun) {
  console.log(
    published
      ? `${name}@${version} is already published; validating package contents only.`
      : `${name}@${version} is not published; validating package contents before publish.`,
  );
  validatePack();
  if (!skipAdvanceLatest) advanceLatestForBetaPhase(name, version, distTag);
  process.exit(0);
}

if (published) {
  console.log(`Skipping publish for ${name}@${version}: already published`);
} else {
  run("npm", ["publish", "--access", "public", "--provenance", "--ignore-scripts", "--tag", distTag]);
}

if (!skipAdvanceLatest) advanceLatestForBetaPhase(name, version, distTag);

function commandForPlatform(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(commandForPlatform(command), args, {
    encoding: "utf8",
    stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      output
        ? `Command failed: ${command} ${args.join(" ")}\n${output}`
        : `Command failed: ${command} ${args.join(" ")}`,
    );
  }

  return result;
}

function assertPackageMetadata() {
  if (name !== "@steflsd/ficta") throw new Error(`package.json has name ${name}, expected @steflsd/ficta`);
  if (pkg.private) throw new Error("package.json private=true; refusing to publish");
}

function assertTagMatchesVersion(tag, packageVersion) {
  if (!tag) return;
  const normalized = tag.startsWith("v") ? tag.slice(1) : tag;
  if (normalized !== packageVersion)
    throw new Error(`release tag ${tag} does not match package.json version ${packageVersion}`);
}

function assertChangelogHasVersion(packageVersion) {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const heading = new RegExp(`^##\\s+${escapeRegExp(packageVersion)}(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m");
  if (!heading.test(changelog)) throw new Error(`CHANGELOG.md has no section for ${packageVersion}`);
}

function assertBuildOutputExists() {
  if (!existsSync("dist")) throw new Error("dist does not exist. Run pnpm build before publishing.");
}

function validatePack() {
  const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true });
  const packed = JSON.parse(result.stdout)[0];
  console.log(
    `  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`,
  );
}

function isPublished(packageName, packageVersion) {
  const result = spawnSync(
    commandForPlatform("npm"),
    ["view", `${packageName}@${packageVersion}`, "version", "--json"],
    {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    },
  );

  if (result.status === 0 && result.stdout.trim()) return true;

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) return false;

  throw new Error(
    output
      ? `Failed to query ${packageName}@${packageVersion}\n${output}`
      : `Failed to query ${packageName}@${packageVersion}`,
  );
}

function npmDistTag(packageVersion) {
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)$/.exec(packageVersion)?.[1];
  return prerelease ? (prerelease.split(".")[0] ?? "next") : "latest";
}

/**
 * During the pre-1.0 beta phase, also point `latest` at the newest prerelease so bare installs
 * (`pnpm add -g @steflsd/ficta`, `pnpm update -L -g`) pick it up. Self-terminating and safe:
 * once `latest` points at a stable release, betas never move it again.
 */
function advanceLatestForBetaPhase(packageName, packageVersion, tag) {
  if (tag === "latest") return; // a stable publish already set `latest`

  const currentLatest = currentDistTagVersion(packageName);

  if (currentLatest && !isPrerelease(currentLatest)) {
    console.log(`latest points at stable ${currentLatest}; leaving it unchanged`);
    return;
  }
  if (currentLatest && compareSemver(packageVersion, currentLatest) <= 0) {
    console.log(`latest ${currentLatest} is already >= ${packageVersion}; leaving it unchanged`);
    return;
  }

  console.log(`Advancing latest -> ${packageVersion} (beta phase)${dryRun ? " (dry run)" : ""}`);
  if (dryRun) return;
  // Best-effort: the package is already published at this point, so a failure here (e.g. no
  // 2FA-exempt automation token in CI, or an interactive OTP prompt) must not fail the release.
  // Warn with the manual recovery command instead of throwing.
  try {
    run("npm", ["dist-tag", "add", `${packageName}@${packageVersion}`, "latest"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `\nwarning: ${name}@${packageVersion} published, but advancing the \`latest\` dist-tag failed.\n` +
        `  latest still points at ${currentLatest ?? "(unset)"}.\n` +
        `  Recover manually:  npm dist-tag add ${packageName}@${packageVersion} latest\n` +
        `  In CI this needs an npm automation token (2FA-exempt) exported as NODE_AUTH_TOKEN.\n` +
        `  ${detail}\n`,
    );
  }
}

function currentDistTagVersion(packageName) {
  const result = spawnSync(commandForPlatform("npm"), ["view", packageName, "dist-tags.latest", "--json"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });

  if (result.status === 0) {
    const stdout = result.stdout.trim();
    return stdout ? String(JSON.parse(stdout)) : null;
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (output.includes("E404") || output.includes("404 Not Found")) return null;

  throw new Error(
    output ? `Failed to read dist-tags for ${packageName}\n${output}` : `Failed to read dist-tags for ${packageName}`,
  );
}

function isPrerelease(version) {
  return version.includes("-");
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
  if (!match) throw new Error(`invalid semver: ${version}`);
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
