# Changelog

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
