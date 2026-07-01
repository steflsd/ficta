#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "extract") args.shift();

const options = parseOptions(args);
const version = options.version ?? (options.tag ? stripLeadingV(options.tag) : undefined);
if (!version) fail("release-notes extract requires --version or --tag");

const changelog = readFileSync(options.changelog, "utf8");
const notes = extractChangelogSection(changelog, version);
if (!notes) fail(`CHANGELOG.md has no notes for ${version}`);

if (options.out) writeFileSync(options.out, `${notes}\n`);
else process.stdout.write(`${notes}\n`);

function parseOptions(values) {
  const out = { changelog: "CHANGELOG.md", out: undefined, tag: undefined, version: undefined };
  for (let i = 0; i < values.length; i++) {
    const arg = values[i];
    if (arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (!["--changelog", "--out", "--tag", "--version"].includes(arg)) fail(`unknown option: ${arg}`);
    const value = values[++i];
    if (!value) fail(`${arg} requires a value`);
    if (arg === "--changelog") out.changelog = value;
    if (arg === "--out") out.out = value;
    if (arg === "--tag") out.tag = value;
    if (arg === "--version") out.version = value;
  }
  return out;
}

function extractChangelogSection(text, version) {
  const heading = new RegExp(
    `^##\\s+(?:\\[)?${escapeRegExp(version)}(?:\\])?(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`,
    "m",
  ).exec(text);
  if (!heading) return "";
  const sectionStart = heading.index + heading[0].length;
  const rest = text.slice(sectionStart);
  const nextHeading = /^##\s+/m.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

function stripLeadingV(value) {
  return value.startsWith("v") ? value.slice(1) : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printUsage() {
  console.log(`Usage: node scripts/release-notes.mjs extract --version <x.y.z> [--out <file>]

Options:
  --version <x.y.z>      Version to extract
  --tag <vX.Y.Z>         Tag to extract; used if --version is omitted
  --changelog <path>     Changelog path (default: CHANGELOG.md)
  --out <path>           Write notes to a file instead of stdout
`);
}

function fail(message) {
  console.error(`release notes failed: ${message}`);
  process.exit(1);
}
