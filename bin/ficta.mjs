#!/usr/bin/env node
// Dev/link entrypoint: runs the TS CLI via the bundled tsx.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const child = spawn(tsx, [join(root, "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (c) => process.exit(c ?? 0));
child.on("error", (e) => {
  process.stderr.write(`ficta: ${e.message}\n`);
  process.exit(1);
});
