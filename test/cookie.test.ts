import { describe, expect, it } from "vitest";
import {
  type AssignmentState,
  assign,
  MAX_COOKIE_EXPERIMENTS,
  markExposed,
  newAssignmentState,
  setCookieHeader,
  signAssignment,
  verifyAssignment,
} from "../src/cookie.ts";
import { b64url, fromB64url, fromUtf8, hmacKey, randomHex, utf8 } from "../src/util.ts";

const newKey = () => hmacKey(crypto.getRandomValues(new Uint8Array(32)));

describe("assignment cookie", () => {
  it("round-trips {v, a, x} with an HMAC signature", async () => {
    const key = await newKey();
    const state: AssignmentState = { v: randomHex(16), a: { exp_A: "var_1" }, x: ["exp_A"] };
    const raw = await signAssignment(key, state);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    const [body] = raw.split(".");
    expect(JSON.parse(fromUtf8(fromB64url(body!)))).toEqual(state);
    expect(await verifyAssignment(key, raw)).toEqual(state);
  });

  it("rejects tampering, foreign keys and junk", async () => {
    const key = await newKey();
    const raw = await signAssignment(key, { v: randomHex(16), a: { exp_A: "var_1" }, x: [] });
    const [body, sig] = raw.split(".") as [string, string];
    const forgedBody = b64url(utf8(JSON.stringify({ v: randomHex(16), a: { exp_A: "var_2" }, x: [] })));
    expect(await verifyAssignment(key, `${forgedBody}.${sig}`)).toBeNull();
    expect(await verifyAssignment(await newKey(), raw)).toBeNull();
    expect(await verifyAssignment(key, body)).toBeNull();
    expect(await verifyAssignment(key, `${body}.${sig}x`)).toBeNull();
    expect(await verifyAssignment(key, "garbage")).toBeNull();
    expect(await verifyAssignment(key, `${"A".repeat(5000)}.${sig}`)).toBeNull();
  });

  it("drops malformed entries from a correctly signed cookie", async () => {
    const key = await newKey();
    const v = randomHex(16);
    const sloppy = { v, a: { exp_A: "var_1", "bad id": "var_2", exp_B: 7 }, x: ["exp_A", "exp_C", 3] };
    const raw = await signAssignment(key, sloppy as unknown as AssignmentState);
    expect(await verifyAssignment(key, raw)).toEqual({ v, a: { exp_A: "var_1" }, x: ["exp_A"] });
    const noVisitor = await signAssignment(key, { v: "short", a: {}, x: [] });
    expect(await verifyAssignment(key, noVisitor)).toBeNull();
  });

  it("keeps the most recent experiments first, at most 10, and exposures only for kept ones", () => {
    const state = newAssignmentState(randomHex(16));
    for (let i = 0; i < 12; i++) {
      assign(state, `exp_${i}`, `var_${i}`);
      markExposed(state, `exp_${i}`);
    }
    expect(Object.keys(state.a)).toHaveLength(MAX_COOKIE_EXPERIMENTS);
    expect(Object.keys(state.a)[0]).toBe("exp_11");
    expect(state.a.exp_0).toBeUndefined();
    expect(state.x).toHaveLength(MAX_COOKIE_EXPERIMENTS);
    expect(state.x.every((id) => id in state.a)).toBe(true);
    expect(markExposed(state, "exp_11")).toBe(false);
    assign(state, "exp_5", "var_other");
    expect(Object.keys(state.a)[0]).toBe("exp_5");
    expect(state.a.exp_5).toBe("var_other");
  });

  it("formats Set-Cookie values", () => {
    expect(setCookieHeader("__pp", "v", 60, { secure: true })).toBe(
      "__pp=v; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure",
    );
    expect(setCookieHeader("__pp_f", "1", 1800, { secure: false, domain: "shop.test" })).toBe(
      "__pp_f=1; Path=/; Max-Age=1800; SameSite=Lax; HttpOnly; Domain=shop.test",
    );
  });
});
