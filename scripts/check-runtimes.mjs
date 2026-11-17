#!/usr/bin/env node
/**
 * Runs the built SDK under every JavaScript runtime it supports: Node (ESM and CommonJS), Bun,
 * Deno (built output and the TypeScript source that JSR publishes) and workerd (Cloudflare
 * Workers, through the Workers Vitest pool). Runtimes that are not installed are reported as skipped.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const has = (bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const runs = [
  ["node (ESM)", "node", ["scripts/runtime-entry.mjs", "dist/index.js"]],
  ["node (CommonJS)", "node", ["scripts/runtime-entry.cjs", "dist/cjs/index.js"]],
  ["bun", "bun", ["scripts/runtime-entry.mjs", "dist/index.js"]],
  ["deno (dist)", "deno", ["run", "--allow-read", "scripts/runtime-entry.mjs", "dist/index.js"]],
  [
    "deno (TypeScript source, as on JSR)",
    "deno",
    ["run", "--allow-read", "scripts/runtime-entry.mjs", "src/index.ts"],
  ],
];

let failed = false;
for (const [name, bin, args] of runs) {
  if (!has(bin)) {
    console.log(`- ${name}: skipped (${bin} not installed)`);
    continue;
  }
  const r = spawnSync(bin, args, { cwd: root, encoding: "utf8" });
  const line = r.stdout.trim().split("\n").pop() ?? "";
  try {
    const { passed, failures } = JSON.parse(line);
    console.log(
      `${failures.length ? "✗" : "✓"} ${name}: ${passed} passed${failures.length ? `, failed: ${failures.join("; ")}` : ""}`,
    );
    failed ||= failures.length > 0 || r.status !== 0;
  } catch {
    console.log(`✗ ${name}: ${r.stderr || r.stdout}`);
    failed = true;
  }
}

const workerd = spawnSync(
  process.execPath,
  [
    join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs"),
    "run",
    "-c",
    "vitest.workers.config.ts",
  ],
  { cwd: root, encoding: "utf8" },
);
console.log(
  `${workerd.status === 0 ? "✓" : "✗"} workerd (Cloudflare Workers): ${workerd.status === 0 ? "passed" : workerd.stdout + workerd.stderr}`,
);
failed ||= workerd.status !== 0;
process.exit(failed ? 1 : 0);
