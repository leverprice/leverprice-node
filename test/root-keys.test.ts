import { describe, expect, it } from "vitest";
import { ROOT_PUBLIC_KEYS } from "../src/index.ts";
import { fromB64url } from "../src/util.ts";

/** Release guard: a published SDK must trust real production root keys, never a placeholder. */
describe("ROOT_PUBLIC_KEYS", () => {
  it("contains only valid raw Ed25519 public keys", async () => {
    const entries = Object.entries(ROOT_PUBLIC_KEYS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, key] of entries) {
      expect(id).toMatch(/^r\d+$/);
      const raw = fromB64url(key);
      expect(raw.length).toBe(32);
      await expect(
        crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]),
      ).resolves.toBeDefined();
    }
  });
});
