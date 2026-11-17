#!/usr/bin/env node
/** ESM (dist/) + CommonJS (dist/cjs/) builds with type declarations for both. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
rmSync(join(root, "dist"), { recursive: true, force: true });
for (const config of ["tsconfig.build.json", "tsconfig.cjs.json"]) {
  execFileSync(process.execPath, [tsc, "-p", join(root, config)], { stdio: "inherit" });
}
// tsc rewrites ".ts" specifiers in JavaScript output but not in declarations.
for (const dir of ["dist", "dist/cjs"]) {
  for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".d.ts"))) {
    const path = join(root, dir, file);
    writeFileSync(path, readFileSync(path, "utf8").replace(/(from "\.\/[a-z]+)\.ts"/g, '$1.js"'));
  }
}
writeFileSync(join(root, "dist/cjs/package.json"), '{ "type": "commonjs" }\n');
