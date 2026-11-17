/** Runtime-agnostic checks of a built SDK against the conformance vectors (no node: imports). */
const GUARDS = {
  pro: { currency: "usd", fallbackPrice: 1900, minPrice: 1500, maxPrice: 3900 },
  basic: { currency: "usd", fallbackPrice: 1000 },
  euro: { currency: "eur", fallbackPrice: 1200, minPrice: 100, maxPrice: 5000 },
  wild: { currency: "usd", fallbackPrice: 2000, minPrice: 1000, maxPrice: 3000 },
  bad: { currency: "usd", fallbackPrice: 150 },
  ghost: { currency: "usd", fallbackPrice: 4900 },
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function runCases(sdk, V) {
  const failures = [];
  let passed = 0;
  const check = (name, ok) => {
    if (ok) passed++;
    else failures.push(name);
  };

  for (const q of V.quotes) {
    const sent = [];
    const fetch = async (url, init) => {
      if (url.endsWith("/v1/config")) {
        return new Response(JSON.stringify(V.config), { status: 200, headers: { ETag: '"v5"' } });
      }
      sent.push(JSON.parse(init.body));
      return new Response('{"accepted":1,"dropped":0}', { status: 202 });
    };
    const lp = new sdk.Leverprice({
      secretKey: V.secretKey,
      products: { ...GUARDS, ...(q.guards ?? {}) },
      trustedRootKeys: V.rootKeys,
      fetch,
      onError: () => {},
    });
    const quote = await lp.getPrice(q.productKey, {
      request: { headers: q.headers },
      userId: q.userId,
      ...(q.exposure ? { exposure: q.exposure } : {}),
      ...(typeof q.bot === "boolean" ? { bot: q.bot } : {}),
    });
    await lp.flush();
    const exposures = sent.flatMap((b) => b.events).map(({ timestamp, ...rest }) => rest);
    const { productKey, ...got } = { ...quote, exposures };
    const { productKey: _p, ...want } = q.expect;
    const keys = Object.keys(want);
    check(`quote: ${q.name}`, same(Object.fromEntries(keys.map((k) => [k, got[k]])), want));
  }

  const request = new Request("https://shop.example/pricing", {
    headers: { "User-Agent": V.bots.find((b) => !b.bot).userAgent },
  });
  const lp = new sdk.Leverprice({
    secretKey: V.secretKey,
    products: GUARDS,
    trustedRootKeys: V.rootKeys,
    fetch: async () => new Response(JSON.stringify(V.config), { status: 200 }),
    onError: () => {},
  });
  const fresh = await lp.getPrice("pro", { request });
  check(
    "fetch Request: new visitor gets a variant and a cookie",
    fresh.reason === "experiment" && fresh.setCookie.length === 1,
  );
  const again = await lp.getPrice("basic", { request });
  check("fetch Request: second product on the same request", again.reason === "base_price");

  const down = new sdk.Leverprice({
    secretKey: V.secretKey,
    products: GUARDS,
    trustedRootKeys: V.rootKeys,
    timeoutMs: 50,
    fetch: () => new Promise(() => {}),
    onError: () => {},
  });
  const started = Date.now();
  const outage = await down.getPrice("pro", { request: { headers: {} } });
  check(
    "cold start timeout falls back",
    outage.reason === "no_config" && outage.price === 1900 && Date.now() - started < 1000,
  );

  for (const b of V.bots) check(`bot: ${b.userAgent.slice(0, 40)}`, sdk.isBot(b.userAgent) === b.bot);
  check(
    "root keys embedded",
    Object.keys(sdk.ROOT_PUBLIC_KEYS).length > 0 && typeof sdk.SDK_VERSION === "string",
  );
  return { passed, failures };
}
