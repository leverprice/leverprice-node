# Changelog

## 0.3.0 — 2026-11-17

- Published as `@leverprice/sdk` on npm and JSR (was `@pricepilot/sdk`). The deprecated `PricePilot` alias is removed; use `Leverprice`.
- CommonJS build next to the ESM build (`require("@leverprice/sdk")`), with types for both.
- Deno: `jsr:@leverprice/sdk` publishes the TypeScript source.
- Tested on Node 20, 22 and 24 (ESM and CommonJS), Bun, Deno and workerd (Cloudflare Workers) against the shared conformance vectors that the Python, PHP, Ruby and Go SDKs also pass.
- Events report the SDK as `@leverprice/sdk`. Cookies, configs and the wire protocol are unchanged.

## 0.2.0

- Protocol v2: root → keyset → config trust chain, key-bound configs, outage pin cookie, manual exposures, bot detection.
