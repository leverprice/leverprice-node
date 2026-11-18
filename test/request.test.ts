import { describe, expect, it } from "vitest";
import { cookieValues, isPrefetch, normalizeCountry, readHeader, readRequest } from "../src/request.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

describe("readHeader", () => {
  it("reads a Fetch Request case-insensitively", () => {
    const req = new Request("https://shop.test/pricing", {
      headers: { Cookie: "a=1; __pp=v.s", "User-Agent": UA },
    });
    expect(readHeader(req, "cookie")).toBe("a=1; __pp=v.s");
    expect(readHeader(req, "User-Agent")).toBe(UA);
    expect(readHeader(req, "x-missing")).toBeNull();
  });

  it("matches header names as ASCII, never with Unicode case mapping", () => {
    const headers = { "X-\u212aountry": "IN", "\u017fec-purpose": "prefetch", "X-COUNTRY": "BR" };
    expect("X-\u212aountry".toLowerCase()).toBe("x-kountry");
    expect(readHeader({ headers }, "x-kountry")).toBeNull();
    expect(readHeader({ headers }, "sec-purpose")).toBeNull();
    expect(readHeader({ headers }, "x-country")).toBe("BR");
  });

  it("reads Node-style header objects, including mixed-case keys and arrays", () => {
    expect(readHeader({ headers: { cookie: "a=1", "user-agent": UA } }, "user-agent")).toBe(UA);
    expect(readHeader({ headers: { Cookie: "a=1", "User-Agent": UA } }, "cookie")).toBe("a=1");
    const node = { headers: { cookie: ["a=1", "__pp=v.s"], "x-list": ["one", "two"], empty: [] } };
    expect(readHeader(node, "cookie")).toBe("a=1; __pp=v.s");
    expect(readHeader(node, "x-list")).toBe("one, two");
    expect(readHeader(node, "empty")).toBeNull();
    expect(readHeader({ headers: { cookie: undefined } }, "cookie")).toBeNull();
  });

  it("treats a header literally named `get` as data, and survives junk", () => {
    expect(readHeader({ headers: { get: "not a function", cookie: "a=1" } }, "cookie")).toBe("a=1");
    expect(readHeader(null, "cookie")).toBeNull();
    expect(readHeader(undefined, "cookie")).toBeNull();
    expect(
      readHeader({ headers: null } as unknown as { headers: Record<string, string> }, "cookie"),
    ).toBeNull();
    const throwing = {
      headers: {
        get() {
          throw new Error("boom");
        },
      },
    };
    expect(readHeader(throwing, "cookie")).toBeNull();
  });
});

describe("cookieValues", () => {
  it("finds every value of one cookie, in order", () => {
    expect(cookieValues("a=1; __pp=one.sig; b=2", "__pp")).toEqual(["one.sig"]);
    expect(cookieValues("__pp=one; x=1;__pp=two", "__pp")).toEqual(["one", "two"]);
    expect(cookieValues("x__pp=1; __pp_f=1; __pp2=3", "__pp")).toEqual([]);
    expect(cookieValues("__pp_f=1", "__pp_f")).toEqual(["1"]);
    expect(cookieValues("", "__pp")).toEqual([]);
    expect(cookieValues(null, "__pp")).toEqual([]);
    expect(cookieValues("__pp=; a=1", "__pp")).toEqual([]);
  });

  it("handles quoted, percent-encoded and comma-joined (Fetch Headers) values", () => {
    expect(cookieValues('__pp="abc.def"', "__pp")).toEqual(["abc.def"]);
    expect(cookieValues("__pp=abc%2Edef", "__pp")).toEqual(["abc.def"]);
    expect(cookieValues("__pp=%E0%A4%A", "__pp")).toEqual(["%E0%A4%A"]); // malformed escape: no throw
    const headers = new Headers();
    headers.append("cookie", "a=1");
    headers.append("cookie", "__pp=v.s");
    expect(cookieValues(headers.get("cookie"), "__pp")).toEqual(["v.s"]);
  });
});

describe("isPrefetch", () => {
  it("recognises speculative loads", () => {
    const fetchReq = (h: Record<string, string>) => new Request("https://shop.test/", { headers: h });
    expect(isPrefetch(fetchReq({ "Sec-Purpose": "prefetch" }))).toBe(true);
    expect(isPrefetch(fetchReq({ "Sec-Purpose": "prefetch;prerender" }))).toBe(true);
    expect(isPrefetch(fetchReq({ "X-Sec-Purpose": "prefetch" }))).toBe(true); // Turbo 8 hover prefetch
    expect(isPrefetch({ headers: { purpose: "prefetch" } })).toBe(true);
    expect(isPrefetch({ headers: { "x-purpose": "preview" } })).toBe(true);
    expect(isPrefetch({ headers: { "x-moz": "prefetch" } })).toBe(true);
    expect(isPrefetch({ headers: { "Next-Router-Prefetch": "1" } })).toBe(true);
  });

  it("does not flag normal navigations", () => {
    expect(isPrefetch(new Request("https://shop.test/", { headers: { "User-Agent": UA } }))).toBe(false);
    expect(isPrefetch({ headers: { rsc: "1" } })).toBe(false);
    expect(isPrefetch(null)).toBe(false);
  });
});

describe("readRequest", () => {
  it("reads cookie, pin and user agent from a Fetch Request", () => {
    const req = new Request("https://shop.test/", {
      headers: { Cookie: "a=1; __pp=v.s; __pp_f=1", "User-Agent": UA },
    });
    expect(readRequest({ request: req }, "__pp")).toEqual({
      cookieInput: "a=1; __pp=v.s; __pp_f=1",
      assignmentCookies: ["v.s"],
      pinned: true,
      userAgent: UA,
      prefetch: false,
      country: null,
    });
  });

  it("reads Node-style headers with arrays", () => {
    const info = readRequest(
      { request: { headers: { cookie: ["a=1", "__pp=v.s"], "user-agent": UA } } },
      "__pp",
    );
    expect(info.assignmentCookies).toEqual(["v.s"]);
    expect(info.pinned).toBe(false);
    expect(info.userAgent).toBe(UA);
  });

  it("lets explicit cookie and userAgent override the request", () => {
    const request = { headers: { cookie: "__pp=from-request", "user-agent": "curl/8.7.1" } };
    const info = readRequest({ request, cookie: "__pp=explicit", userAgent: UA }, "__pp");
    expect(info.assignmentCookies).toEqual(["explicit"]);
    expect(info.userAgent).toBe(UA);
    // null means "not given": fall back to the request
    expect(readRequest({ request, cookie: null, userAgent: null }, "__pp")).toMatchObject({
      assignmentCookies: ["from-request"],
      userAgent: "curl/8.7.1",
    });
  });

  it("accepts the bare value of the Leverprice cookie (legacy form)", () => {
    expect(readRequest({ cookie: " body.sig " }, "__pp")).toMatchObject({
      assignmentCookies: ["body.sig"],
      pinned: false,
    });
  });

  it("copes with no request at all", () => {
    expect(readRequest({}, "__pp")).toEqual({
      cookieInput: null,
      assignmentCookies: [],
      pinned: false,
      userAgent: null,
      prefetch: false,
      country: null,
    });
  });

  it("reads the country from the header it is told to trust, and from nowhere else", () => {
    const request = { headers: { "cf-ipcountry": "br", "x-vercel-ip-country": "IN" } };
    expect(readRequest({ request }, "__pp").country).toBeNull();
    expect(readRequest({ request }, "__pp", "cf-ipcountry").country).toBe("BR");
    expect(readRequest({ request }, "__pp", "x-vercel-ip-country").country).toBe("IN");
    expect(readRequest({ request, country: "de" }, "__pp", "cf-ipcountry").country).toBe("DE");
    expect(readRequest({ request, country: "nowhere" }, "__pp", "cf-ipcountry").country).toBeNull();
    expect(readRequest({ request, country: null }, "__pp", "cf-ipcountry").country).toBe("BR");
    expect(
      readRequest({ request: { headers: { "cf-ipcountry": "XX" } } }, "__pp", "cf-ipcountry").country,
    ).toBeNull();
    expect(
      readRequest({ request: { headers: { "cf-ipcountry": "T1" } } }, "__pp", "cf-ipcountry").country,
    ).toBeNull();
  });
});

describe("normalizeCountry", () => {
  it("accepts two ASCII letters, in any case, with ASCII whitespace around them", () => {
    expect(normalizeCountry("US")).toBe("US");
    expect(normalizeCountry("br")).toBe("BR");
    expect(normalizeCountry(" de ")).toBe("DE");
    expect(normalizeCountry("\tin\r\n")).toBe("IN");
  });

  it("refuses what is not a country", () => {
    for (const value of ["XX", "ZZ", "T1", "A1", "A2", "AP", "EU", "", "U", "USA", "u s", "us\nde"])
      expect(normalizeCountry(value)).toBeNull();
    for (const value of [null, undefined, 42, ["US"], { country: "US" }])
      expect(normalizeCountry(value)).toBeNull();
  });

  it("never lets case mapping or Unicode whitespace turn something else into a country", () => {
    for (const value of ["ß", "ın", "ﬁ", "ſe"]) {
      expect(value.toUpperCase()).toMatch(/^[A-Z]{2}$/);
      expect(normalizeCountry(value)).toBeNull();
    }
    expect("\u212aR").toMatch(/^[a-z]{2}$/iu);
    for (const value of ["\u212aR", "ＵＳ", "\u00a0US", "US\u00a0", "\u2003US", "\ufeffUS", "US\u0085"])
      expect(normalizeCountry(value)).toBeNull();
    for (const value of ["\u001cUS", "US\u0000"]) expect(normalizeCountry(value)).toBeNull();
  });
});
