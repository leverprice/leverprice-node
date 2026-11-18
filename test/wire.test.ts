import { describe, expect, it } from "vitest";
import { b64url, utf8 } from "../src/util.ts";
import { eventProblem, parseConfig, type WireEvent } from "../src/wire.ts";

const now = Date.now();
const encode = (v: unknown) => b64url(utf8(JSON.stringify(v)));
const assignmentKey = b64url(crypto.getRandomValues(new Uint8Array(32)));
const product = {
  id: "prod_1",
  currency: "USD",
  price: 1900,
  minPrice: 1500,
  maxPrice: 3900,
  experiment: null,
};
const payload = (over: Record<string, unknown> = {}) => ({
  schema: 2,
  projectId: "proj_1",
  version: 3,
  issuedAt: now,
  expiresAt: now + 60_000,
  assignmentKey,
  keyFingerprints: ["0123456789abcdef"],
  products: { pro: product },
  ...over,
});

describe("parseConfig", () => {
  it("accepts schema 2 and normalises products", () => {
    const { config, dropped } = parseConfig(encode(payload()));
    expect(dropped).toEqual([]);
    expect(config).toMatchObject({ projectId: "proj_1", version: 3, assignmentKey });
    expect(config.products.get("pro")).toEqual({
      ...product,
      currency: "usd",
      regions: [],
      regionOf: new Map(),
    });
  });

  it("refuses other schemas, missing assignment keys and junk", () => {
    expect(() => parseConfig(encode(payload({ schema: 1 })))).toThrow(/unsupported schema 1/);
    expect(() => parseConfig(encode(payload({ assignmentKey: "AAAA" })))).toThrow(/assignmentKey/);
    expect(() => parseConfig(encode(payload({ products: null })))).toThrow(/products/);
    expect(() => parseConfig(encode(payload({ keyFingerprints: undefined })))).toThrow(/keyFingerprints/);
    expect(() => parseConfig(encode(payload({ keyFingerprints: ["not-hex"] })))).toThrow(/keyFingerprints/);
    expect(() => parseConfig("not base64!")).toThrow(/base64url JSON/);
  });

  it("drops only the malformed product and strips non-https checkout links", () => {
    const { config, dropped } = parseConfig(
      encode(
        payload({
          products: {
            pro: { ...product, checkoutUrl: "javascript:alert(1)" },
            team: { ...product, price: "1900" },
            biz: {
              ...product,
              experiment: {
                id: "exp_1",
                salt: "s",
                variants: [{ id: "var_1", price: 1900, weight: 10_000 }],
              },
              checkoutUrl: "https://buy.stripe.com/x",
            },
          },
        }),
      ),
    );
    expect(dropped).toEqual(["team"]);
    expect(config.products.get("pro")?.checkoutUrl).toBeUndefined();
    expect(config.products.get("biz")?.checkoutUrl).toBe("https://buy.stripe.com/x");
    expect(config.products.has("constructor")).toBe(false);
  });

  it("reads regional prices and drops a product whose regions don't add up", () => {
    const regions = [
      { countries: ["BR", "MX"], currency: "usd", price: 2000 },
      { countries: ["IN"], currency: "INR", price: 99_900 },
    ];
    const experiment = (regional: unknown[]) => ({
      id: "exp_1",
      salt: "s",
      variants: [
        { id: "var_1", price: 1900, weight: 5000, regional: regional[0] },
        { id: "var_2", price: 3900, weight: 5000, regional: regional[1] },
      ],
    });
    const { config, dropped } = parseConfig(
      encode(
        payload({
          products: {
            flat: { ...product, regions: [] },
            geo: { ...product, regions },
            test: {
              ...product,
              regions,
              experiment: experiment([
                [1300, 64_900],
                [2700, 129_900],
              ]),
            },
            ignored: { ...product, experiment: experiment([[1], "junk"]) },
            twice: { ...product, regions: [...regions, { countries: ["IN"], currency: "usd", price: 1 }] },
            lower: { ...product, regions: [{ countries: ["in"], currency: "inr", price: 1 }] },
            empty: { ...product, regions: [{ countries: [], currency: "inr", price: 1 }] },
            free: { ...product, regions: [{ countries: ["IN"], currency: "inr", price: 0 }] },
            money: { ...product, regions: [{ countries: ["IN"], currency: "rupee", price: 1 }] },
            shape: { ...product, regions: { IN: 1 } },
            short: { ...product, regions, experiment: experiment([[1300], [2700, 129_900]]) },
            missing: { ...product, regions, experiment: experiment([[1300, 64_900], undefined]) },
            zero: {
              ...product,
              regions,
              experiment: experiment([
                [1300, 0],
                [2700, 129_900],
              ]),
            },
          },
        }),
      ),
    );
    expect(dropped).toEqual([
      "twice",
      "lower",
      "empty",
      "free",
      "money",
      "shape",
      "short",
      "missing",
      "zero",
    ]);
    expect(config.products.get("flat")).toMatchObject({ regions: [], regionOf: new Map() });
    const geo = config.products.get("geo")!;
    expect(geo.regions[1]).toEqual({ countries: ["IN"], currency: "inr", price: 99_900 });
    expect([...geo.regionOf]).toEqual([
      ["BR", 0],
      ["MX", 0],
      ["IN", 1],
    ]);
    expect(config.products.get("test")!.experiment!.variants.map((v) => v.regional)).toEqual([
      [1300, 64_900],
      [2700, 129_900],
    ]);
    expect(config.products.get("ignored")!.experiment!.variants.map((v) => v.regional)).toEqual([[], []]);
  });
});

describe("eventProblem (mirror of the server schema)", () => {
  const purchase: WireEvent = {
    type: "purchase",
    provider: "stripe",
    orderId: "pi_1",
    amount: 2900,
    currency: "usd",
    timestamp: now,
    attribution: {
      experimentId: "exp_A",
      variantId: "var_1",
      visitorId: "a".repeat(32),
      signature: "0123456789abcdef",
    },
  };

  it("accepts valid events", () => {
    expect(eventProblem(purchase)).toBeNull();
    expect(eventProblem({ ...purchase, attribution: null })).toBeNull();
    expect(
      eventProblem({ type: "exposure", experimentId: "e", variantId: "v", visitorId: "x", timestamp: now }),
    ).toBeNull();
    const refund = {
      type: "refund",
      provider: "polar",
      orderId: "o",
      currency: "eur",
      timestamp: now,
    } as const;
    expect(eventProblem({ ...refund, refundedTotal: 100 })).toBeNull();
    expect(eventProblem({ ...refund, refundId: "re_1", amount: 100 })).toBeNull();
  });

  it("names what is wrong", () => {
    expect(eventProblem({ ...purchase, amount: -1 })).toMatch(/amount/);
    expect(eventProblem({ ...purchase, amount: 19.9 })).toMatch(/amount/);
    expect(eventProblem({ ...purchase, currency: "usdx" })).toMatch(/currency/);
    expect(eventProblem({ ...purchase, orderId: "" })).toMatch(/orderId/);
    expect(eventProblem({ ...purchase, orderId: "x".repeat(256) })).toMatch(/orderId/);
    expect(eventProblem({ ...purchase, timestamp: Number.NaN })).toMatch(/timestamp/);
    expect(eventProblem({ ...purchase, provider: "paypal" as "other" })).toMatch(/provider/);
    const exposure = {
      type: "exposure",
      experimentId: "e",
      variantId: "v",
      visitorId: "x",
      timestamp: now,
    } as const;
    expect(eventProblem({ ...exposure, country: "IN" })).toBeNull();
    expect(eventProblem({ ...exposure, country: "in" })).toMatch(/country/);
    expect(eventProblem({ ...exposure, country: "IND" })).toMatch(/country/);
    expect(
      eventProblem({ ...purchase, attribution: { ...purchase.attribution!, signature: "NOT-HEX-0000000" } }),
    ).toMatch(/attribution/);
    const refund = {
      type: "refund",
      provider: "polar",
      orderId: "o",
      currency: "eur",
      timestamp: now,
    } as const;
    expect(eventProblem(refund)).toMatch(/refundId \+ amount, or refundedTotal/);
    expect(eventProblem({ ...refund, refundId: "re_1" })).toMatch(/refundId \+ amount/);
  });
});
