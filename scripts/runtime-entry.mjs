/** `<runtime> runtime-entry.mjs <path to the SDK entry>`: prints the result as JSON. */
import V from "../conformance/vectors.json" with { type: "json" };
import { runCases } from "./runtime-cases.mjs";

const target = (globalThis.Deno?.args ?? globalThis.process?.argv.slice(2) ?? [])[0];
const sdk = await import(new URL(target, `file://${globalThis.Deno ? Deno.cwd() : process.cwd()}/`).href);
const result = await runCases(sdk, V);
console.log(JSON.stringify(result));
if (result.failures.length > 0) (globalThis.Deno?.exit ?? process.exit)(1);
