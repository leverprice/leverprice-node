/** CommonJS consumers: `require("@leverprice/sdk")`. */
const path = require("node:path");
const sdk = require(path.resolve(process.argv[2]));
const V = require("../conformance/vectors.json");
import("./runtime-cases.mjs").then(async ({ runCases }) => {
  const result = await runCases(sdk, V);
  console.log(JSON.stringify(result));
  if (result.failures.length > 0) process.exit(1);
});
