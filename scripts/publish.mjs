#!/usr/bin/env node
/** Publish the single ficta npm package, idempotently. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
if (unknownArgs.length > 0) {
  console.error("Usage: node scripts/publish.mjs [--dry-run]");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const name = String(pkg.name);
const version = String(pkg.version);
const expectedTag = process.env.RELEASE_TAG;
const distTag = npmDistTag(version);

assertPackageMetadata();
assertTagMatchesVersion(expectedTag, version);
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
  process.exit(0);
}

if (published) {
  console.log(`Skipping ${name}@${version}: already published`);
  process.exit(0);
}

run("npm", ["publish", "--access", "public", "--provenance", "--ignore-scripts", "--tag", distTag]);

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
