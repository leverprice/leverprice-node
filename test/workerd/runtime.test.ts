import { expect, it } from "vitest";
import V from "../../conformance/vectors.json";
import * as sdk from "../../dist/index.js";
// @ts-expect-error plain .mjs helper shared by every runtime check
import { runCases } from "../../scripts/runtime-cases.mjs";

it("passes the conformance quotes and bot vectors in workerd", async () => {
  expect(navigator.userAgent).toBe("Cloudflare-Workers");
  const { passed, failures } = await runCases(sdk, V);
  expect(failures).toEqual([]);
  expect(passed).toBeGreaterThan(80);
});
