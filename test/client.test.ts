/**
 * Client behaviour that needs no signed config. Signing, assignment and the server contract are
 * covered by packages/core/test/contract.test.ts against the real server code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FetchLike, Leverprice, type LeverpriceOptions } from "../src/index.ts";

const secretKey = `pp_sk_test_${"a1B2c3D4e5".repeat(4)}`;
const products = { pro: { currency: "USD", fallbackPrice: 1900 } };

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { events: Record<string, unknown>[] } | null;
}

function api(statuses: number[] = []) {
  const sent: Sent[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    sent.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (url.endsWith("/v1/config")) return new Response("{}", { status: 503 });
    return new Response("{}", { status: statuses.shift() ?? 202 });
  });
  return { fetch, sent, events: () => sent.filter((s) => s.url.endsWith("/v1/events")) };
}

const make = (extra: Partial<LeverpriceOptions> = {}) =>
  new Leverprice({ secretKey, products, onError: () => {}, ...extra });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("switched off", () => {
  it.each(["1", "true", "TRUE", " true "])(
    "LEVERPRICE_DISABLED=%j: fallback, no network, no logs",
    async (value) => {
      vi.stubEnv("LEVERPRICE_DISABLED", value);
      const { fetch } = api();
      const onError = vi.fn();
      const pp = make({ fetch, onError });
      const q = await pp.getPrice("pro", { request: { headers: { "user-agent": "Mozilla/5.0" } } });
      expect(q).toMatchObject({
        price: 1900,
        isFallback: true,
        reason: "disabled",
        setCookie: [],
        visitorId: null,
      });
      await pp.trackPurchase({ provider: "stripe", orderId: "pi_1", amount: 1900, currency: "usd" });
      await pp.preload();
      await pp.refresh();
      await pp.flush();
      expect(fetch).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "false", ""])("LEVERPRICE_DISABLED=%j does not switch it off", async (value) => {
    vi.stubEnv("LEVERPRICE_DISABLED", value);
    const { fetch } = api();
    const q = await make({ fetch }).getPrice("pro");
    expect(q.reason).toBe("no_config");
    expect(fetch).toHaveBeenCalled();
  });

  it("is re-checked on every call", async () => {
    const { fetch } = api();
    const pp = make({ fetch });
    vi.stubEnv("LEVERPRICE_DISABLED", "1");
    expect((await pp.getPrice("pro")).reason).toBe("disabled");
    vi.stubEnv("LEVERPRICE_DISABLED", "0");
    expect((await pp.getPrice("pro")).reason).toBe("no_config");
  });

  it("without a valid secret key: fallback, no network; a malformed key is reported once", async () => {
    const { fetch } = api();
    const onError = vi.fn();
    for (const key of [undefined, null, "", "sk_live_123", `pp_sk_live_${"x".repeat(39)}`]) {
      const pp = new Leverprice({ secretKey: key, products, fetch, onError });
      expect(await pp.getPrice("pro")).toMatchObject({ reason: "disabled", price: 1900, setCookie: [] });
      await pp.trackPurchase({ provider: "stripe", orderId: "pi_1", amount: 1, currency: "usd" });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe("configuration errors", () => {
  it("throws for a product missing from the products option", async () => {
    await expect(make().getPrice("nope")).rejects.toThrow(/unknown product "nope"/);
  });

  it("validates guards", () => {
    const bad = (g: object) => () => new Leverprice({ secretKey, products: { pro: g as never } });
    expect(bad({ currency: "usd", fallbackPrice: 0 })).toThrow(/fallbackPrice/);
    expect(bad({ currency: "usd", fallbackPrice: 19.5 })).toThrow(/fallbackPrice/);
    expect(bad({ currency: "dollars", fallbackPrice: 1900 })).toThrow(/currency/);
    expect(bad({ currency: "usd", fallbackPrice: 1900, minPrice: 10, maxPrice: 5 })).not.toThrow();
    expect(bad({ currency: "usd", fallbackPrice: 1900, minPrice: "19", maxPrice: null })).not.toThrow();
    expect(() => new Leverprice({ secretKey, products, cookieName: "bad name;" })).toThrow(/cookieName/);
  });

  it("ignores a countryHeader that visitors' browsers send, and says so once", async () => {
    for (const countryHeader of [
      "Accept-Language",
      "x-forwarded-for",
      "X-Real-IP",
      "sec-ch-ua",
      "user-agent",
    ]) {
      const onError = vi.fn();
      const { fetch } = api();
      const pp = make({ countryHeader, onError, fetch });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0]?.[0])).toMatch(/sent by visitors' browsers.*ignored/);
      const q = await pp.getPrice("pro", { request: { headers: { [countryHeader]: "IN" } } });
      expect(q.country).toBeNull();
    }
    for (const countryHeader of ["cf-ipcountry", "x-vercel-ip-country", "x-geo-country"]) {
      const onError = vi.fn();
      make({ countryHeader, onError });
      expect(onError).not.toHaveBeenCalled();
    }
    const onError = vi.fn();
    make({ countryHeader: "accept-language", onError, disabled: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it("validates countryHeader before changing its case", () => {
    for (const countryHeader of ["bad name", "x:y", "\u212aey", "\u00a0cf-ipcountry", "cf-ipcountry\u2003"])
      expect(() => make({ countryHeader })).toThrow(/countryHeader/);
    for (const countryHeader of [5, ["cf-ipcountry"], {}])
      expect(() => make({ countryHeader: countryHeader as never })).toThrow(/countryHeader is not a valid/);
    expect(() => make({ countryHeader: null as never })).not.toThrow();
    for (const countryHeader of ["CF-IPCountry", " cf-ipcountry\n", "", "  "])
      expect(() => make({ countryHeader })).not.toThrow();
  });
});

describe("events", () => {
  it("sends purchases with the secret key and the server's field names", async () => {
    const { fetch, events } = api();
    await make({ fetch }).trackPurchase({
      provider: "stripe",
      orderId: "pi_1",
      amount: 2900.4,
      currency: "EUR",
      timestamp: 1_760_000_000, // Unix seconds are converted
      metadata: { pp_exp: "exp_A", pp_var: "var_2", pp_vid: "abc", pp_sig: "0123456789abcdef", other: "x" },
    });
    const [req] = events();
    expect(req?.headers.Authorization).toBe(`Bearer ${secretKey}`);
    expect(req?.body?.events).toEqual([
      {
        type: "purchase",
        provider: "stripe",
        orderId: "pi_1",
        amount: 2900,
        currency: "eur",
        timestamp: 1_760_000_000_000,
        attribution: {
          experimentId: "exp_A",
          variantId: "var_2",
          visitorId: "abc",
          signature: "0123456789abcdef",
        },
      },
    ]);
  });

  it("keeps attribution without a valid tag (the server decides) and drops incomplete attribution", async () => {
    const { fetch, events } = api();
    const pp = make({ fetch });
    await pp.trackPurchase({
      provider: "polar",
      orderId: "o1",
      amount: 100,
      currency: "usd",
      metadata: { pp_exp: "exp_A", pp_var: "var_2", pp_vid: "abc", pp_sig: "NOT-A-TAG" },
    });
    await pp.trackPurchase({
      provider: "polar",
      orderId: "o2",
      amount: 100,
      currency: "usd",
      metadata: { pp_exp: "e" },
    });
    const sent = events().flatMap((r) => r.body?.events ?? []);
    expect(sent[0]?.attribution).toEqual({
      experimentId: "exp_A",
      variantId: "var_2",
      visitorId: "abc",
      signature: null,
    });
    expect(sent[1]?.attribution).toBeNull();
  });

  it("drops an invalid event instead of letting it poison the batch", async () => {
    const { fetch, events } = api();
    const onError = vi.fn();
    const pp = make({ fetch, onError });
    await pp.trackPurchase({
      provider: "stripe",
      orderId: null as unknown as string,
      amount: 1,
      currency: "usd",
    });
    await pp.trackPurchase({ provider: "stripe", orderId: "pi_ok", amount: Number.NaN, currency: "usd" });
    await pp.trackPurchase({ provider: "stripe", orderId: "pi_ok", amount: null as never, currency: "usd" });
    await pp.trackRefund({ provider: "stripe", orderId: "pi_ok", currency: "usd", refundedTotal: -5 });
    await pp.trackRefund({
      provider: "stripe",
      orderId: "pi_ok",
      currency: "usd",
      refundedTotal: "5" as never,
    });
    await pp.trackRefund({ provider: "stripe", orderId: "pi_ok", currency: "usd", refundedTotal: 500 });
    expect(onError).toHaveBeenCalledTimes(5);
    expect(events().flatMap((r) => r.body?.events ?? [])).toEqual([
      expect.objectContaining({ type: "refund", orderId: "pi_ok", refundedTotal: 500 }),
    ]);
  });

  it("logs a manual exposure with the quote's country, or without one when it is not a country", async () => {
    const { fetch, events } = api();
    const pp = make({ fetch });
    const quote = (visitorId: string, country: unknown) =>
      ({ reason: "experiment", experimentId: "exp_1", variantId: "var_1", visitorId, country }) as never;
    expect(pp.logExposure(quote("v1", " br "))).toBe(true);
    expect(pp.logExposure(quote("v2", "ß"))).toBe(true);
    expect(pp.logExposure(quote("v3", 42))).toBe(true);
    expect(pp.logExposure(quote("v4", undefined))).toBe(true);
    await pp.flush();
    const sent = events().flatMap((r) => r.body?.events ?? []);
    expect(sent.map((e) => [e.visitorId, e.country])).toEqual([
      ["v1", "BR"],
      ["v2", undefined],
      ["v3", undefined],
      ["v4", undefined],
    ]);
  });

  it("never throws, whatever it is given", async () => {
    const pp = make({ fetch: api().fetch });
    await expect(pp.trackPurchase(null as never)).resolves.toBeUndefined();
    await expect(pp.trackRefund(undefined as never)).resolves.toBeUndefined();
    expect(pp.logExposure({} as never)).toBe(false);
  });

  it("retries money events, re-queues them when the API stays down, and sends them later", async () => {
    const { fetch, events } = api([503, 503, 503, 202]);
    const onError = vi.fn();
    const pp = make({ fetch, onError });
    await pp.trackPurchase({ provider: "stripe", orderId: "pi_1", amount: 1900, currency: "usd" });
    expect(events()).toHaveLength(3);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Leverprice events: HTTP 503" }));
    await pp.flush();
    expect(events()).toHaveLength(4);
    expect(events()[3]?.body?.events).toEqual([expect.objectContaining({ orderId: "pi_1" })]);
    await pp.flush();
    expect(events()).toHaveLength(4);
  });

  it("does not retry a permanent rejection", async () => {
    const { fetch, events } = api([400]);
    const onError = vi.fn();
    const pp = make({ fetch, onError });
    await pp.trackRefund({ provider: "dodo", orderId: "p_1", refundId: "r_1", amount: 5, currency: "usd" });
    await pp.flush();
    expect(events()).toHaveLength(1);
    expect(onError.mock.calls[0]?.[0].message).toMatch(/rejected: HTTP 400/);
  });

  it("gives up on a hanging API after the request timeout instead of hanging flush()", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetch = vi.fn<FetchLike>(() => new Promise(() => {}));
      const pp = make({ fetch });
      const done = pp.trackPurchase({ provider: "stripe", orderId: "pi_1", amount: 1, currency: "usd" });
      await vi.advanceTimersByTimeAsync(3 * 10_000 + 1_250 + 100);
      await expect(done).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Edge runtimes (e.g. Workers) cancel a finished request's I/O and timers, so a promise it started can
// stay pending forever. Simulated here by moving the clock past STALL_MS (15 s) while that promise's
// own (real) timeout has not fired.
describe("work stalled by a torn-down request", () => {
  it("starts a new config fetch instead of waiting on a dead one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let hang = true;
      const fetch = vi.fn<FetchLike>(async () =>
        hang ? new Promise<never>(() => {}) : new Response("{}", { status: 503 }),
      );
      const pp = make({ fetch, timeoutMs: 20 });
      expect((await pp.getPrice("pro")).reason).toBe("no_config");
      expect((await pp.getPrice("pro")).reason).toBe("no_config");
      expect(fetch).toHaveBeenCalledTimes(1); // single flight while it may still be alive
      hang = false;
      vi.setSystemTime(Date.now() + 16_000);
      await pp.getPrice("pro");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for a dead send and delivers its money events with the next flush", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let hang = true;
      const bodies: string[] = [];
      const fetch = vi.fn<FetchLike>(async (_url, init) => {
        bodies.push(init.body ?? "");
        return hang ? new Promise<never>(() => {}) : new Response("{}", { status: 202 });
      });
      const pp = make({ fetch });
      void pp.trackPurchase({ provider: "stripe", orderId: "pi_stuck", amount: 1, currency: "usd" });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      hang = false;
      vi.setSystemTime(Date.now() + 16_000);
      await pp.trackPurchase({ provider: "stripe", orderId: "pi_next", amount: 2, currency: "usd" });
      const sent = bodies
        .slice(1)
        .flatMap((b) => (JSON.parse(b) as { events: { orderId: string }[] }).events.map((e) => e.orderId));
      expect(sent).toEqual(["pi_stuck", "pi_next"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what the client tells the server", () => {
  it("names its products on every config request, keys encoded and in order", async () => {
    const { fetch, sent } = api();
    const pp = new Leverprice({
      secretKey,
      products: {
        team: { currency: "EUR", fallbackPrice: 4900 },
        "pro plan": { currency: "usd", fallbackPrice: 1900 },
        "\u00e9t\u00e9": { currency: "usd", fallbackPrice: 900 },
      },
      fetch,
      onError: () => {},
    });
    await pp.refresh();
    await pp.refresh();
    const configs = sent.filter((r) => r.url.endsWith("/v1/config"));
    expect(configs.length).toBeGreaterThanOrEqual(2);
    for (const r of configs) {
      expect(r.headers["Leverprice-Products"]).toBe("%C3%A9t%C3%A9=usd, pro%20plan=usd, team=eur");
      expect(r.headers["Leverprice-Config-Error"]).toBeUndefined(); // an outage is not a refused config
    }
  });

  it("says why it refused the last config until one is accepted", async () => {
    const sent: Record<string, string>[] = [];
    const bodies = ["not json", JSON.stringify({ payload: "x" })];
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      sent.push(init.headers);
      return new Response(bodies.shift() ?? "{}", { status: 200 });
    });
    const pp = make({ fetch });
    await pp.refresh();
    await pp.refresh();
    await pp.refresh();
    expect(sent.map((h) => h["Leverprice-Config-Error"] ?? null)).toEqual([null, "malformed", "malformed"]);
    expect(sent.every((h) => h["Leverprice-Products"] === "pro=usd")).toBe(true);
  });
});
