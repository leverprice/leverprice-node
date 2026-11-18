/** The shared conformance vectors (sdks/conformance/vectors.json) that every Leverprice SDK passes. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBot } from "../src/bots.ts";
import {
  type AssignmentState,
  assign,
  markExposed,
  setCookieHeader,
  signAssignment,
  verifyAssignment,
} from "../src/cookie.ts";
import { type FetchLike, Leverprice, type ProductGuard } from "../src/index.ts";
import {
  clientAddress,
  cookieValues,
  isPrefetch,
  normalizeAddress,
  normalizeCountry,
  visitorSetHeader,
} from "../src/request.ts";
import { bucketFor, fromB64url, hex, hmacHex, hmacKey, pickVariant, utf8 } from "../src/util.ts";
import { eventProblem, type WireEvent } from "../src/wire.ts";

function findVectors(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    for (const candidate of ["conformance/vectors.json", "sdks/conformance/vectors.json"]) {
      if (existsSync(join(dir, candidate))) return join(dir, candidate);
    }
    const up = dirname(dir);
    if (up === dir) throw new Error("conformance/vectors.json not found");
    dir = up;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: test data straight from JSON
const V: any = JSON.parse(readFileSync(findVectors(), "utf8"));
type Pairs = [string, string][];
interface VState {
  v: string;
  a: Pairs;
  x: string[];
}
const toState = (s: VState): AssignmentState => ({ v: s.v, a: Object.fromEntries(s.a), x: [...s.x] });
const fromState = (s: AssignmentState | null): VState | null =>
  s && { v: s.v, a: Object.entries(s.a) as Pairs, x: s.x };
const key = () => hmacKey(fromB64url(V.assignmentKey));

const DEFAULT_GUARDS: Record<string, ProductGuard> = {
  pro: { currency: "usd", fallbackPrice: 1900 },
  basic: { currency: "usd", fallbackPrice: 1000 },
  euro: { currency: "eur", fallbackPrice: 1200 },
  wild: { currency: "usd", fallbackPrice: 2000 },
  bad: { currency: "usd", fallbackPrice: 150 },
  ghost: { currency: "usd", fallbackPrice: 4900 },
  geo: { currency: "usd", fallbackPrice: 2900 },
  geox: { currency: "usd", fallbackPrice: 2900 },
  badgeo: { currency: "usd", fallbackPrice: 2900 },
  badgeox: { currency: "usd", fallbackPrice: 2900 },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("conformance: trust chain and config acceptance", () => {
  for (const c of V.trust)
    it(c.name, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const steps = c.steps as {
        envelope: unknown;
        expect: string;
        version?: number;
        now?: number;
        code?: string;
        countryHeader?: string | null;
      }[];
      let served: unknown = null;
      const fetch: FetchLike = async () =>
        new Response(JSON.stringify(served), { status: 200, headers: { ETag: '"x"' } });
      const errors: string[] = [];
      const lp = new Leverprice({
        secretKey: V.secretKey,
        products: DEFAULT_GUARDS,
        trustedRootKeys: V.rootKeys,
        fetch,
        onError: (e) => errors.push(e.message),
      });
      if (c.minKeysetVersion) {
        // biome-ignore lint/suspicious/noExplicitAny: the floor is a module constant; the chain takes it per instance
        (lp as any).trust.minKeysetVersion = c.minKeysetVersion;
      }
      for (const step of steps) {
        vi.setSystemTime(step.now ?? V.now);
        // biome-ignore lint/suspicious/noExplicitAny: inspecting the loaded config
        const before = (lp as any).config;
        served = step.envelope;
        await lp.refresh();
        // biome-ignore lint/suspicious/noExplicitAny: inspecting the loaded config
        const after = (lp as any).config;
        const accepted = after !== before && after !== null;
        expect(accepted ? "accept" : "reject").toBe(step.expect);
        if (accepted) expect(after.version).toBe(step.version);
        if (accepted && step.countryHeader !== undefined)
          expect(after.countryHeader).toBe(step.countryHeader);
        // What the next config request reports in Leverprice-Config-Error.
        // biome-ignore lint/suspicious/noExplicitAny: inspecting the reported refusal
        expect((lp as any).configError).toBe(accepted ? null : step.code);
      }
    });
});

describe("conformance: primitives", () => {
  it("key fingerprints", async () => {
    for (const { secretKey, fingerprint } of V.keyFingerprints) {
      const h = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(secretKey)));
      expect(hex(h).slice(0, 16)).toBe(fingerprint);
    }
  });

  it("visitor ids and attribution tags", async () => {
    const k = await key();
    for (const v of V.visitorIds) expect(await hmacHex(k, v.message, 32)).toBe(v.visitorId);
    for (const a of V.attribution) expect(await hmacHex(k, a.message, 16)).toBe(a.signature);
  });

  it("buckets and variant picks", async () => {
    for (const b of V.buckets) expect(await bucketFor(b.salt, b.visitorId)).toBe(b.bucket);
    for (const p of V.pickVariant) {
      const variants: { weight: number; i: number }[] = p.weights.map((weight: number, i: number) => ({
        weight,
        i,
      }));
      expect(pickVariant(variants, p.bucket).i).toBe(p.index);
    }
  });

  it("signs cookies byte for byte", async () => {
    const k = await key();
    for (const c of V.cookies.sign) {
      const s = toState(c.state);
      expect(JSON.stringify({ v: s.v, a: s.a, x: s.x })).toBe(c.json);
      expect(await signAssignment(k, s)).toBe(c.cookie);
    }
  });

  for (const c of V.cookies.verify)
    it(`verifies cookie: ${c.name}`, async () => {
      expect(fromState(await verifyAssignment(await key(), c.cookie))).toEqual(c.state);
    });

  for (const c of V.cookies.ops)
    it(`cookie op: ${c.name}`, () => {
      const s = toState(c.state);
      if (c.op.assign) assign(s, c.op.assign[0], c.op.assign[1]);
      else expect(markExposed(s, c.op.markExposed)).toBe(c.changed);
      expect(fromState(s)).toEqual(c.result);
    });

  it("parses cookie headers, prefetch hints and writes Set-Cookie", () => {
    for (const c of V.cookieHeader) expect(cookieValues(c.header, c.name), c.header).toEqual(c.values);
    for (const p of V.prefetch)
      expect(isPrefetch({ headers: p.headers }), JSON.stringify(p.headers)).toBe(p.prefetch);
    for (const c of V.setCookie) {
      expect(
        setCookieHeader(c.name, c.value, c.maxAge, { secure: c.secure, domain: c.domain ?? undefined }),
      ).toBe(c.header);
    }
  });

  it("normalises countries", () => {
    for (const c of V.countries) expect(normalizeCountry(c.value), JSON.stringify(c.value)).toBe(c.country);
  });

  it("detects bots", () => {
    for (const b of V.bots) expect(isBot(b.userAgent), b.userAgent).toBe(b.bot);
  });

  it("validates events before queueing", () => {
    for (const e of V.events)
      expect(eventProblem(e.event as WireEvent) === null, JSON.stringify(e.event)).toBe(e.valid);
  });
});

describe("conformance: quotes", () => {
  for (const q of V.quotes)
    it(q.name, async () => {
      const sent: { events: Record<string, unknown>[] }[] = [];
      const fetch: FetchLike = async (url, init) => {
        if (url.endsWith("/v1/config")) {
          return new Response(JSON.stringify(V.config), { status: 200, headers: { ETag: '"v5"' } });
        }
        sent.push(JSON.parse(init.body ?? "null"));
        return new Response('{"accepted":1,"dropped":0}', { status: 202 });
      };
      const errors: string[] = [];
      const lp = new Leverprice({
        secretKey: V.secretKey,
        products: { ...DEFAULT_GUARDS, ...(q.guards ?? {}) },
        trustedRootKeys: V.rootKeys,
        fetch,
        onError: (e) => errors.push(e.message),
        ...(q.countryHeader ? { countryHeader: q.countryHeader } : {}),
        ...(typeof q.localCurrencies === "boolean" ? { localCurrencies: q.localCurrencies } : {}),
      });
      const quote = await lp.getPrice(q.productKey, {
        request: { headers: q.headers },
        userId: q.userId,
        ...(q.exposure ? { exposure: q.exposure } : {}),
        ...(typeof q.bot === "boolean" ? { bot: q.bot } : {}),
        ...(typeof q.country === "string" ? { country: q.country } : {}),
      });
      await lp.flush();
      const exposures = sent.flatMap((b) => b.events).map(({ timestamp: _t, ...rest }) => rest);
      expect({ ...quote, productKey: undefined, exposures }).toEqual({ ...q.expect, productKey: undefined });
      expect(errors.filter((e) => !e.includes("malformed products"))).toEqual(q.errors);
    });
});

describe("conformance: country sources, cookieless visitors, reports", () => {
  it("refuses country headers that visitors send", () => {
    for (const c of V.countryHeaderNames) expect(!visitorSetHeader(c.name), c.name).toBe(c.allowed);
  });

  it("normalises addresses and finds the visitor's", () => {
    for (const a of V.addresses) expect(normalizeAddress(a.value), JSON.stringify(a.value)).toBe(a.address);
    for (const c of V.clientAddresses) {
      const request = {
        headers: c.headers,
        ...(c.remoteAddress ? { socket: { remoteAddress: c.remoteAddress } } : {}),
      };
      expect(clientAddress(request), JSON.stringify(c)).toBe(c.address);
    }
  });

  it("derives a cookieless visitor's key", async () => {
    const k = await key();
    for (const a of V.anonVisitors) {
      expect(a.message).toBe(`pp:anon:v1:${a.address}\n${a.userAgent}\n${a.acceptLanguage}`);
      expect(await hmacHex(k, a.message, 32)).toBe(a.v);
    }
  });

  it("names its products on GET /v1/config", async () => {
    for (const c of V.productsHeader) {
      let header: string | undefined;
      const fetch: FetchLike = async (_url, init) => {
        header = init.headers["Leverprice-Products"];
        return new Response("{}", { status: 503 });
      };
      await new Leverprice({
        secretKey: V.secretKey,
        products: c.products,
        fetch,
        onError: () => {},
      }).refresh();
      expect(header).toBe(c.header);
    }
  });
});

describe("conformance: VPN guard (countryHold)", () => {
  const H = V.countryHold;
  for (const c of H.cases)
    it(c.name, async () => {
      const k = await key();
      const now = Math.floor(Date.now() / 1000);
      let cookie: string | null = null;
      let t: number | undefined;
      if (c.cookie) {
        t = c.cookie.age === undefined ? undefined : now - c.cookie.age;
        const state: AssignmentState = {
          v: H.visitor,
          a: Object.fromEntries(c.cookie.a ?? []),
          x: c.cookie.x ?? [],
          ...(c.cookie.c !== undefined ? { c: c.cookie.c, t } : {}),
        };
        cookie = await signAssignment(k, state);
      }
      const sent: { events: Record<string, unknown>[] }[] = [];
      const fetch: FetchLike = async (url, init) => {
        if (url.endsWith("/v1/config")) {
          return new Response(JSON.stringify(H.config), { status: 200, headers: { ETag: '"v5"' } });
        }
        sent.push(JSON.parse(init.body ?? "null"));
        return new Response('{"accepted":1,"dropped":0}', { status: 202 });
      };
      const errors: string[] = [];
      const lp = new Leverprice({
        secretKey: V.secretKey,
        products: H.guards,
        trustedRootKeys: V.rootKeys,
        fetch,
        onError: (e) => errors.push(e.message),
        ...(c.localCurrencies ? { localCurrencies: true } : {}),
      });
      const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 Chrome/131.0" };
      if (c.country) headers["x-geo-country"] = c.country;
      if (cookie) headers.cookie = `__pp=${cookie}`;
      const q = await lp.getPrice(c.productKey, { request: { headers } });
      await lp.flush();
      const set = q.setCookie.find((h) => h.startsWith("__pp="));
      const back = set ? await verifyAssignment(k, set.slice(5).split(";")[0]!) : null;
      expect({
        price: q.price,
        currency: q.currency,
        country: q.country,
        regional: q.regional,
        reason: q.reason,
        variantId: q.variantId,
        exposures: sent.flatMap((b) => b.events).map(({ timestamp: _t, visitorId: _v, ...rest }) => rest),
        cookie: back && {
          c: back.c ?? null,
          t: back.t === undefined ? null : back.t === t ? "kept" : "fresh",
          a: Object.entries(back.a),
        },
      }).toEqual(c.expect);
      if (back?.t !== undefined && back.t !== t) expect(Math.abs(back.t - now)).toBeLessThan(5);
      expect(errors).toEqual([]);
    });
});
