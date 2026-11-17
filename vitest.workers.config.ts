import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** The built SDK inside workerd, the Cloudflare Workers runtime. */
export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-11-01" } })],
  test: { include: ["test/workerd/**/*.test.ts"] },
});
