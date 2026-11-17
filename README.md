<a href="https://leverprice.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/leverprice/.github/main/assets/repo/node-dark.svg">
    <img alt="Leverprice SDK for Node.js" src="https://raw.githubusercontent.com/leverprice/.github/main/assets/repo/node-light.svg" width="100%">
  </picture>
</a>

<p>
  <a href="https://www.npmjs.com/package/@leverprice/sdk"><img alt="npm" src="https://img.shields.io/npm/v/%40leverprice%2Fsdk?label=npm&style=flat-square&labelColor=0F1011&color=5B4CF5"></a>
  <a href="https://jsr.io/@leverprice/sdk"><img alt="JSR" src="https://img.shields.io/jsr/v/%40leverprice/sdk?label=jsr&style=flat-square&labelColor=0F1011&color=5B4CF5"></a>
  <a href="https://github.com/leverprice/leverprice-node/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/leverprice/leverprice-node/ci.yml?branch=main&label=ci&style=flat-square&labelColor=0F1011"></a>
  <a href="https://github.com/leverprice/leverprice-node/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-5B4CF5?style=flat-square&labelColor=0F1011"></a>
</p>

Server-side SDK for [Leverprice](https://leverprice.com) price experiments. Zero dependencies (WebCrypto and `fetch` only), ESM and CommonJS, full TypeScript types.

Runs on Node ≥ 20, Bun, Deno, Cloudflare Workers, Vercel and Netlify (Node and edge functions), AWS Lambda and any other runtime with WebCrypto Ed25519 and `fetch`. Also available for [Python](https://github.com/leverprice/leverprice-python), [PHP](https://github.com/leverprice/leverprice-php), [Ruby](https://github.com/leverprice/leverprice-ruby) and [Go](https://github.com/leverprice/leverprice-go); every SDK passes the same [conformance vectors](https://github.com/leverprice/leverprice-node/tree/main/conformance).

```bash
npm install @leverprice/sdk        # or: pnpm add / yarn add / bun add @leverprice/sdk
deno add jsr:@leverprice/sdk       # Deno (npm:@leverprice/sdk works too)
```

**Your payments stay yours.** The SDK hands your server a number. Your existing code creates the checkout with your own provider keys. Leverprice never sees card data or provider API keys.

```ts
import { Leverprice } from "@leverprice/sdk"; // or: const { Leverprice } = require("@leverprice/sdk");

export const leverprice = new Leverprice({
  secretKey: process.env.LEVERPRICE_SECRET_KEY, // server-only, never in the browser
  products: {
    // Local guardrails: prices outside these bounds are never returned.
    pro: { currency: "usd", fallbackPrice: 1900, minPrice: 1500, maxPrice: 3900 },
  },
});
leverprice.preload(); // optional, long-lived servers: fetch the config at startup, not on the first request

// 1. Where the price is shown. `request` is a Fetch Request or a Node IncomingMessage.
const quote = await leverprice.getPrice("pro", { request, userId: user?.id });
for (const cookie of quote.setCookie) headers.append("Set-Cookie", cookie); // Express: res.append("Set-Cookie", quote.setCookie)
render(quote.price); // minor units

// 2. Where you create the checkout. Never trust a price sent by the browser.
const q = await leverprice.getPrice("pro", { request });
await stripe.checkout.sessions.create({
  mode: "payment",
  line_items: [{ quantity: 1, price_data: { currency: q.currency, unit_amount: q.price, product_data: { name: "Pro" } } }],
  metadata: q.metadata, // signed attribution: pass it whole
  payment_intent_data: { metadata: q.metadata },
  success_url, cancel_url,
});

// 3. In your webhook handler (or connect your provider's webhooks to Leverprice directly).
await leverprice.trackPurchase({
  provider: "stripe",
  orderId: session.payment_intent,
  amount: session.amount_total - (session.total_details?.amount_tax ?? 0),
  currency: session.currency,
  metadata: session.metadata,
});
```

## Guarantees

- **Fails safe.** If Leverprice is off, slow (no config within 500 ms), down, misconfigured or returns anything unexpected, `getPrice()` returns your `fallbackPrice`. It never throws for those reasons.
- **Verified config.** Root key → keyset → config signature chain, version-monotonic (no rollback, no revoked keys), time-limited.
- **Bounded.** Every price is checked against your local `minPrice`/`maxPrice` and `currency`.
- **Sticky and tamper-proof.** Visitors keep their price. The assignment cookie is HMAC-signed with your project's assignment key (delivered in the signed config), so rotating your API key does not reshuffle visitors.
- **Private.** Visitor and user ids are HMAC-hashed on your server; Leverprice only sees the hash.
- **No price flips.** A visitor who got the fallback during an outage keeps it for the rest of their session.
- **Search engines see the standard price.** Crawlers and link previews are never put into experiments.
- **Serverless-friendly.** No timers keep your process alive. Call `await leverprice.flush()` (or `ctx.waitUntil(leverprice.flush())`) before a function returns.

## Frameworks

`getPrice()` takes the request object your framework already has.

```ts
// Fetch Request: Next.js route handlers and server actions, Remix / React Router, SvelteKit, Astro,
// Hono (c.req.raw), Cloudflare Workers, Deno, Bun
const quote = await leverprice.getPrice("pro", { request });
const res = Response.json({ price: quote.price });
for (const c of quote.setCookie) res.headers.append("Set-Cookie", c);

// Node IncomingMessage: Express, Fastify (request.raw), Koa (ctx.req), NestJS, Next.js pages router
const quote = await leverprice.getPrice("pro", { request: req });
res.append("Set-Cookie", quote.setCookie);

// Nuxt / h3
const quote = await leverprice.getPrice("pro", { request: event.node.req });
for (const c of quote.setCookie) appendResponseHeader(event, "Set-Cookie", c);
```

React Server Components can read cookies but cannot set them. Price new visitors where a response can carry `Set-Cookie` (a route handler, a server action, or middleware/`proxy.ts`), or pass `cookie` and `userAgent` from `headers()` for visitors who already have the cookie.

On Cloudflare Workers and other edge runtimes, create the client once per isolate (module scope) and pass `ctx.waitUntil(leverprice.flush())` so exposures are sent after the response.

## Requests and cookies

Pass the incoming `request` (Fetch `Request`, or Node `IncomingMessage` / any `{ headers }` object, array values included). The SDK reads the `Cookie` header, the `User-Agent` and prefetch hints from it. `cookie` and `userAgent` in the context override what is read from the request.

`quote.setCookie` is an **array** of `Set-Cookie` header values: usually empty, one value when the assignment cookie (`__pp`) changes, or the outage pin (`__pp_f`). Append every value to your response.

Pricing several products for one page? Pass the **same `request` object** to each `getPrice()` call: the quotes share one visitor cookie, and the last quote's cookie carries every assignment.

## Exposures

An exposure is one human seeing an experiment price. With `exposure: "auto"` (default) the SDK logs it the first time a visitor gets a price from an experiment, once per visitor and experiment (remembered in the cookie; the server deduplicates too). Prefetch and prerender requests (`Sec-Purpose`, `Purpose`, `X-Moz`, `Next-Router-Prefetch`) are priced but not counted.

If you compute the price before it is visible (background render, hidden tab, modal), use manual mode:

```ts
const quote = await leverprice.getPrice("pro", { request, exposure: "manual" });
// …later, when the price is actually on screen:
leverprice.logExposure(quote);
```

## Bots

Crawlers, link previewers (Slack, WhatsApp, iMessage…), headless browsers, uptime/performance monitors and command-line clients get the product's standard price (or your fallback if no config is available) with reason `"bot"`: no assignment, no cookie, no exposure. An empty user agent counts as a person. Bring your own detection with `getPrice(key, { request, bot: true | false })`; the built-in check is exported as `isBot(userAgent)`.

## Kill switch

Set `LEVERPRICE_DISABLED=1` (or `true`) in the environment, or pass `disabled: true`. It is checked on every call: `getPrice()` returns your fallback price with reason `"disabled"`, sets no cookies, makes no network calls and logs nothing; `trackPurchase`, `trackRefund` and `logExposure` do nothing. A missing or malformed `secretKey` behaves the same way (a malformed key is reported once through `onError`).

## Outages

When no usable config is available (reason `"no_config"`), the quote also sets `__pp_f=1` for 30 minutes. While a browser has it, it gets the fallback price with reason `"pinned_fallback"` and is not enrolled; each pinned request extends it, so the price changes only after 30 minutes of inactivity. The cookie is unsigned on purpose: it can only select your own fallback price.

## Trust chain and updates

The SDK embeds only Leverprice's offline root public keys (`ROOT_PUBLIC_KEYS`). Each config carries a keyset of online signing keys signed by a root key, and must be signed by one of those keys. Keyset versions only move forward within a process (a revoked key cannot come back with an older keyset, and a config it signed stops being trusted); `MIN_KEYSET_VERSION` sets the floor for fresh processes. Config versions only move forward, and configs expire. For local development pass `trustedRootKeys: { r1: "<your dev root public key>" }`.

The config is refreshed every 30 s (with ETag revalidation), driven by traffic. When any Leverprice response announces a newer version in `Leverprice-Config-Version`, the SDK fetches it right away.

## Reference

`getPrice(productKey, context?) → Promise<Quote>` — context: `request`, `cookie`, `userAgent`, `userId`, `exposure`, `bot`. Throws only if `productKey` is missing from `products`.

| Quote field | |
|---|---|
| `productKey` | The key you asked for |
| `price` | Minor units; use it for display and as the checkout amount |
| `currency` | Lowercase ISO 4217, from your product guard |
| `isFallback` | `true` when `price` is your `fallbackPrice` |
| `reason` | See below |
| `experimentId`, `variantId` | Set when `reason` is `"experiment"`, else `null` |
| `visitorId` | Hashed visitor id Leverprice sees; `null` unless `reason` is `"experiment"` |
| `metadata` | `{ pp_exp, pp_var, pp_vid, pp_sig }` for the checkout (signed); `{}` otherwise |
| `setCookie` | `Set-Cookie` values to append (zero or more) |
| `checkoutUrl` | No-code mode: hosted checkout link for this price, or `null` |
| `exposureLogged` | An exposure for this visitor and experiment has been logged (now or earlier) |

| `reason` | Price |
|---|---|
| `experiment` | The visitor's sticky variant |
| `base_price` | Standard price (no experiment running) |
| `bot` | Standard price, or fallback if unavailable; never enrolled |
| `disabled` | Fallback: kill switch, or no valid secret key |
| `no_config` | Fallback: no usable signed config (timeout, outage, rejected or expired); sets the pin |
| `pinned_fallback` | Fallback: this browser got a fallback during an outage in this session |
| `unknown_product` | Fallback: the config has no such product |
| `currency_mismatch` | Fallback: the config's currency differs from your guard |
| `out_of_bounds` | Fallback: a price is outside your (or Leverprice's) min/max |

| Method | |
|---|---|
| `logExposure(quote)` | Logs a manual-mode exposure; returns `true` if one was queued |
| `trackPurchase({ provider, orderId, amount, currency, metadata, timestamp? })` | Reads `pp_exp`/`pp_var`/`pp_vid`/`pp_sig` from `metadata`. Never throws |
| `trackRefund({ provider, orderId, currency, refundId, amount } \| { …, refundedTotal })` | Never throws |
| `flush()` | Sends queued events (≤ 500 per request; money events are retried and kept on failure) |
| `refresh()` / `preload()` | Fetch the config now / only if none is loaded |

Options: `apiUrl`, `disabled`, `timeoutMs` (500), `refreshIntervalMs` (30 s), `maxStaleMs` (24 h), `cookieName` (`__pp`), `cookieMaxAgeSeconds` (180 days), `cookieSecure` (`true`), `cookieDomain`, `flushIntervalMs` (2 s), `trustedRootKeys`, `fetch`, `onError`.

**Upgrading from 0.2 (`@pricepilot/sdk`):** the package is now `@leverprice/sdk`; the deprecated `PricePilot` alias is gone (use `Leverprice`). Nothing else changed: cookies and configs are compatible.

**Upgrading from 0.1:** `setCookie` is now an array, `visitorId` can be `null`, `publicKeys` became `trustedRootKeys`, and 0.1 assignment cookies are not recognised (visitors are assigned again once).

MIT licensed.
