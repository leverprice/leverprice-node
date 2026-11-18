# Changelog

## 0.4.1 — 2026-11-18

- VPN guard: a visitor keeps the price of a country that pays more, where they were seen in the last 7 days, so a VPN to a cheaper country no longer lowers the price. A visitor who moves to a dearer country pays its price from then on. The held country is `quote.country` and lives in the signed `__pp` cookie, which a regional product now sets even without a test. Turned on by the signed config; older SDKs ignore it.
- A visitor who refuses cookies keeps one price and counts once: without a cookie, the visitor is keyed by an HMAC of their IP address (IPv6 by its /64), browser and languages, made with the project's secret. Neither leaves your server.
- `countryHeader` naming a header every browser sends (`Accept-Language`, `X-Forwarded-For`…) is ignored and reported to `onError`, and such a header in the project settings is never read: visitors can no longer pick their own country.
- Every config request says which products your code prices (`Leverprice-Products`) and why the last config was refused, if it was (`Leverprice-Config-Error`), so the dashboard's Setup page turns green only when visitors get real prices and otherwise says what to fix.
- A cold start no longer gives up early: each request waits its own `timeoutMs` for the first config, even when an unawaited `preload()` or another request started the fetch earlier. Before, a busy server answered the first visitors with the fallback after 2–340 ms, said nothing, and pinned them to it for 30 minutes. A request that does give up now reports `Leverprice config: still loading after 500 ms (timeoutMs); …` to `onError`, once per fetch.

## 0.4.0 — 2026-11-18

- Settings live in Leverprice, not in code: the product's price range and the header that carries the visitor's country (Project settings → Visitor country) arrive in the signed config. `minPrice` and `maxPrice` in code are no longer used; 0.3 code that sets them keeps compiling and running.
- Upgrading: limits set in code (`minPrice`, `maxPrice`) no longer hold prices. If they were tighter than the product's range in Leverprice, tighten the range in the dashboard before you upgrade.
- Regional prices: a product can cost something else in each country, in your currency or the visitor's. `country` in the `getPrice()` context, `country` / `regional` on the quote, and a `countryHeader` option that overrides the project setting. Prices in the visitor's currency need `localCurrencies: true` (set it when your checkout charges `quote.currency`); `quote.currency` is then the region's currency.
- Exposures carry the visitor's country when it is known.
- Tests by country: a test can run in selected countries only, and countries can be split between the prices their own way. Both are set in the dashboard; the SDK only needs the visitor's country.
- Cookies and the wire protocol are compatible with 0.3.
- Turbo 8 hover prefetches (`X-Sec-Purpose: prefetch`) are priced but no longer counted as exposures, like other prefetches.
- README: the Stripe webhook example counts only paid Checkout Sessions, handles `checkout.session.async_payment_succeeded` and reports a subscription's first payment by its PaymentIntent id (as verified webhooks do) and skips $0 sessions.
- `trackPurchase()` and `trackRefund()` accept the providers `paddle` and `creem`.
- TypeScript: `Quote` has two new required fields, `country` and `regional`, and `ProviderName` two new members. A hand-built `Quote` or an exhaustive `switch` over providers needs them; runtime code is unaffected.

## 0.3.0 — 2026-11-17

- Published as `@leverprice/sdk` on npm and JSR (was `@pricepilot/sdk`). The deprecated `PricePilot` alias is removed; use `Leverprice`.
- CommonJS build next to the ESM build (`require("@leverprice/sdk")`), with types for both.
- Deno: `jsr:@leverprice/sdk` publishes the TypeScript source.
- Tested on Node 20, 22 and 24 (ESM and CommonJS), Bun, Deno and workerd (Cloudflare Workers) against the shared conformance vectors that the Python, PHP, Ruby and Go SDKs also pass.
- Events report the SDK as `@leverprice/sdk`. Cookies, configs and the wire protocol are unchanged.

## 0.2.0

- Protocol v2: root → keyset → config trust chain, key-bound configs, outage pin cookie, manual exposures, bot detection.
