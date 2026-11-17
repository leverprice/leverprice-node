import { isBot } from "./bots.ts";
import {
  type AssignmentState,
  assign,
  type CookieAttributes,
  cloneState,
  markExposed,
  newAssignmentState,
  setCookieHeader,
  signAssignment,
  verifyAssignment,
} from "./cookie.ts";
import { type RequestInfo, type RequestLike, readRequest } from "./request.ts";
import { type SigningKey, TrustChain } from "./trust.ts";
import {
  bucketFor,
  fromB64url,
  hex,
  hmacHex,
  hmacKey,
  own,
  pickVariant,
  randomHex,
  sleep,
  unrefTimer,
  utf8,
  waitAtMost,
} from "./util.ts";
import {
  CONFIG_VERSION_HEADER,
  type Config,
  type ConfigProduct,
  eventProblem,
  MAX_EVENTS_PER_REQUEST,
  type ProviderName,
  type WireEvent,
} from "./wire.ts";

export { isBot } from "./bots.ts";
export type { FetchRequestLike, NodeRequestLike, RequestLike } from "./request.ts";
export type { ProviderName } from "./wire.ts";

export const SDK_VERSION = "0.3.0";

/** Production root public keys (raw Ed25519, base64url) by id. */
export const ROOT_PUBLIC_KEYS: Record<string, string> = {
  r1: "5FmNzXvPMPZEuDnFT_fFd_VVNsUrWwWTKLerMWbSdcg",
};

/** Lowest keyset version this release accepts. */
export const MIN_KEYSET_VERSION = 1;

export interface ProductGuard {
  /** ISO 4217 code, e.g. "usd". */
  currency: string;
  /** Price in minor units served whenever Leverprice cannot answer. */
  fallbackPrice: number;
  /** Hard bounds in minor units. Prices outside them are never returned. */
  minPrice?: number;
  maxPrice?: number;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The subset of `fetch` the SDK uses. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface LeverpriceOptions {
  /** Secret key (`pp_sk_live_…` or `pp_sk_test_…`). Without a valid key the SDK serves fallback prices. */
  secretKey: string | undefined | null;
  /** Products by key, with local guardrails. */
  products: Record<string, ProductGuard>;
  /** Serve fallback prices with no network calls. Also set by `LEVERPRICE_DISABLED=1`. */
  disabled?: boolean;
  apiUrl?: string;
  /** Maximum wait for a config on a cold start. Default 500 ms. */
  timeoutMs?: number;
  /** Config revalidation interval. Default 30 s. */
  refreshIntervalMs?: number;
  /** Maximum age of a config not confirmed by the server. Default 24 h. */
  maxStaleMs?: number;
  /** Assignment cookie name. Default `__pp`. */
  cookieName?: string;
  /** Assignment cookie lifetime. Default 180 days. */
  cookieMaxAgeSeconds?: number;
  /** Adds the `Secure` attribute. Default true. */
  cookieSecure?: boolean;
  cookieDomain?: string;
  /** Maximum delay before queued exposures are sent. Default 2 s. */
  flushIntervalMs?: number;
  /** Root public keys by id. Default `ROOT_PUBLIC_KEYS`. */
  trustedRootKeys?: Record<string, string>;
  fetch?: FetchLike;
  /** Error handler. Default `console.warn`. */
  onError?: (error: Error) => void;
}

/** Why a quote has its price. */
export type QuoteReason =
  | "experiment"
  | "base_price"
  | "bot"
  | "disabled"
  | "no_config"
  | "pinned_fallback"
  | "unknown_product"
  | "currency_mismatch"
  | "out_of_bounds";

export interface Quote {
  productKey: string;
  /** Price in minor units, for display and checkout. */
  price: number;
  /** Lowercase ISO 4217 code. */
  currency: string;
  /** `price` is the product's `fallbackPrice`. */
  isFallback: boolean;
  reason: QuoteReason;
  experimentId: string | null;
  variantId: string | null;
  /** HMAC-derived visitor id. */
  visitorId: string | null;
  /** Signed attribution to pass whole into the checkout metadata. */
  metadata: Record<string, string>;
  /** `Set-Cookie` header values to append to the response. */
  setCookie: string[];
  /** Hosted checkout link for this price, if configured. */
  checkoutUrl: string | null;
  /** The exposure for this visitor and experiment has been logged. */
  exposureLogged: boolean;
}

export interface GetPriceContext {
  /** Fetch `Request` or Node `IncomingMessage`. */
  request?: RequestLike | null;
  /** `Cookie` header. Overrides `request`. */
  cookie?: string | null;
  /** `User-Agent` header. Overrides `request`. */
  userAgent?: string | null;
  /** Signed-in user id: the same price on every device. Only its HMAC leaves the server. */
  userId?: string | number | null;
  /** `"manual"` defers the exposure to `logExposure(quote)`. Default `"auto"`. */
  exposure?: "auto" | "manual";
  /** Bot verdict that replaces the built-in user-agent check. */
  bot?: boolean;
}

export interface PurchaseInput {
  provider: ProviderName;
  /** Order id as reported by the provider's webhook. */
  orderId: string;
  /** Minor units, after discounts, excluding tax. */
  amount: number;
  currency: string;
  /** Checkout metadata carrying the quote's attribution. */
  metadata?: Record<string, unknown> | null;
  /** Milliseconds or seconds since the epoch. Default: now. */
  timestamp?: number;
}

export type RefundInput = {
  provider: ProviderName;
  orderId: string;
  currency: string;
  /** Milliseconds or seconds since the epoch. Default: now. */
  timestamp?: number;
} & ({ refundId: string; amount: number } | { refundedTotal: number });

interface Guard {
  currency: string;
  fallbackPrice: number;
  minPrice: number;
  maxPrice: number;
}

interface RequestScope {
  tail: Promise<unknown>;
  cookie: {
    input: string | null;
    userId: string | null;
    assignmentKey: string;
    state: AssignmentState;
  } | null;
  pinned: boolean;
}

interface ApiResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: string;
}

const KEY_RE = /^pp_sk_(live|test)_[0-9A-Za-z]{40}$/;
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SIG_RE = /^[0-9a-f]{16}$/;
const PIN_MAX_AGE_SECONDS = 1800;
const REQUEST_TIMEOUT_MS = 10_000;
/** Edge runtimes may cancel a finished request's I/O, leaving its promises unsettled. */
const STALL_MS = REQUEST_TIMEOUT_MS + 5_000;
const MAX_QUEUE = 5_000;
const AUTO_FLUSH_AT = 100;
const SEND_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 30_000;
const CATCH_UP_GAP_MS = 5_000;
const MAX_DEDUPE = 10_000;
const noop = () => {};

export class Leverprice {
  private readonly secretKey: string | null;
  private fingerprint: Promise<string> | null = null;
  private readonly guards: Map<string, Guard>;
  private readonly disabled: boolean;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;
  private readonly refreshIntervalMs: number;
  private readonly maxStaleMs: number;
  private readonly cookieName: string;
  private readonly cookieMaxAge: number;
  private readonly cookieAttrs: CookieAttributes;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly trust: TrustChain;

  private config: Config | null = null;
  private signingKey: SigningKey | null = null;
  private etag: string | null = null;
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  private inflightStartedAt = 0;
  private failures = 0;
  private retryAt = 0;
  private serverVersion = 0;
  private catchUpAt = 0;
  private hmacCache: { raw: string; key: Promise<CryptoKey> } | null = null;

  private queue: WireEvent[] = [];
  private flushTail: Promise<void> = Promise.resolve();
  private drainBeat = 0;
  private sending: WireEvent[] | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly exposed = new Set<string>();
  private readonly scopes = new WeakMap<object, RequestScope>();

  constructor(options: LeverpriceOptions) {
    this.guards = normalizeGuards(options.products);
    this.disabled = options.disabled === true;
    this.apiUrl = (options.apiUrl ?? "https://api.leverprice.com").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 500;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 30_000;
    this.maxStaleMs = options.maxStaleMs ?? 24 * 3600_000;
    this.cookieName = options.cookieName ?? "__pp";
    if (!COOKIE_NAME_RE.test(this.cookieName))
      throw new Error("Leverprice: cookieName is not a valid cookie name");
    this.cookieMaxAge = options.cookieMaxAgeSeconds ?? 180 * 24 * 3600;
    this.cookieAttrs = { secure: options.cookieSecure ?? true, domain: options.cookieDomain };
    this.flushIntervalMs = options.flushIntervalMs ?? 2_000;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.onError = options.onError;
    this.trust = new TrustChain(options.trustedRootKeys ?? ROOT_PUBLIC_KEYS, MIN_KEYSET_VERSION);
    const key = typeof options.secretKey === "string" ? options.secretKey.trim() : "";
    this.secretKey = KEY_RE.test(key) ? key : null;
    if (key && !this.secretKey && !this.disabled && !envDisabled()) {
      this.emit(
        new Error("Leverprice: secretKey is not a pp_sk_live_… / pp_sk_test_… key; serving fallback prices."),
      );
    }
  }

  /** Returns the price to show and charge. Throws only for a product key missing from `products`. */
  async getPrice(productKey: string, context?: GetPriceContext | null): Promise<Quote> {
    const guard = this.guards.get(productKey);
    if (!guard)
      throw new Error(`Leverprice: unknown product "${productKey}". Add it to the products option.`);
    if (this.isOff()) return fallbackQuote(productKey, guard, "disabled");
    const ctx = context ?? {};
    const request = ctx.request;
    if (typeof request !== "object" || request === null) return this.quote(productKey, guard, ctx, null);
    let scope = this.scopes.get(request);
    if (!scope) {
      scope = { tail: Promise.resolve(), cookie: null, pinned: false };
      this.scopes.set(request, scope);
    }
    const current = scope;
    const run = current.tail.then(() => this.quote(productKey, guard, ctx, current));
    current.tail = run.then(noop, noop);
    return run;
  }

  /** Logs the exposure of a `"manual"` quote once its price is visible. */
  logExposure(quote: Quote): boolean {
    try {
      if (this.isOff() || quote.reason !== "experiment" || quote.exposureLogged) return false;
      const { experimentId, variantId, visitorId } = quote;
      if (!experimentId || !variantId || !visitorId) return false;
      const queued = this.recordExposure(experimentId, variantId, visitorId);
      quote.exposureLogged = true;
      return queued;
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  private async quote(
    productKey: string,
    guard: Guard,
    ctx: GetPriceContext,
    scope: RequestScope | null,
  ): Promise<Quote> {
    let bot = false;
    try {
      const req = readRequest(ctx, this.cookieName);
      bot = typeof ctx.bot === "boolean" ? ctx.bot : isBot(req.userAgent);
      if (bot) return await this.botQuote(productKey, guard);
      if (req.pinned || scope?.pinned) {
        this.kick(Date.now());
        return fallbackQuote(productKey, guard, "pinned_fallback", [this.pinCookie()]);
      }
      const config = await this.currentConfig();
      if (!config) return this.noConfig(productKey, guard, scope);
      const product = config.products.get(productKey);
      if (!product) return fallbackQuote(productKey, guard, "unknown_product");
      if (product.currency !== guard.currency) return fallbackQuote(productKey, guard, "currency_mismatch");
      const exp = product.experiment;
      if (!exp) {
        return inBounds(guard, product, product.price)
          ? priceQuote(productKey, guard, product.price, "base_price", product.checkoutUrl)
          : fallbackQuote(productKey, guard, "out_of_bounds");
      }
      if (exp.variants.length === 0 || !exp.variants.every((v) => inBounds(guard, product, v.price))) {
        return fallbackQuote(productKey, guard, "out_of_bounds");
      }
      return await this.experimentQuote(productKey, guard, ctx, req, scope, config, product, exp);
    } catch (err) {
      this.report(err);
      return bot ? fallbackQuote(productKey, guard, "bot") : this.noConfig(productKey, guard, scope);
    }
  }

  private async experimentQuote(
    productKey: string,
    guard: Guard,
    ctx: GetPriceContext,
    req: RequestInfo,
    scope: RequestScope | null,
    config: Config,
    product: ConfigProduct,
    exp: NonNullable<ConfigProduct["experiment"]>,
  ): Promise<Quote> {
    const key = await this.hmacKeyFor(config.assignmentKey);

    const userId = normalizeUserId(ctx.userId);
    const prior = scope?.cookie;
    let state: AssignmentState | null = null;
    if (
      prior &&
      prior.input === req.cookieInput &&
      prior.userId === userId &&
      prior.assignmentKey === config.assignmentKey
    ) {
      state = cloneState(prior.state);
    } else {
      for (const raw of req.assignmentCookies.slice(0, 4)) {
        state = await verifyAssignment(key, raw);
        if (state) break;
      }
    }
    let changed = false;
    if (!state) {
      state = newAssignmentState(randomHex(16));
      changed = true;
    }

    const visitorKey = userId !== null ? `u:${userId}` : `a:${state.v}`;
    const visitorId = await hmacHex(key, `pp:visitor:v1:${visitorKey}`, 32);

    const assigned = own(state.a, exp.id);
    const sticky = assigned === undefined ? undefined : exp.variants.find((v) => v.id === assigned);
    const variant = sticky ?? pickVariant(exp.variants, await bucketFor(exp.salt, visitorId));
    if (!sticky) {
      assign(state, exp.id, variant.id);
      changed = true;
    }

    let logged = state.x.includes(exp.id) || this.exposed.has(`${exp.id}:${visitorId}`);
    if (!logged && (ctx.exposure ?? "auto") === "auto" && !req.prefetch) {
      this.recordExposure(exp.id, variant.id, visitorId);
      logged = true;
    }
    if (logged && markExposed(state, exp.id)) changed = true;

    if (scope) scope.cookie = { input: req.cookieInput, userId, assignmentKey: config.assignmentKey, state };
    const signature = await hmacHex(key, `pp:attr:v1:${exp.id}:${variant.id}:${visitorId}`, 16);
    return {
      productKey,
      price: variant.price,
      currency: guard.currency,
      isFallback: false,
      reason: "experiment",
      experimentId: exp.id,
      variantId: variant.id,
      visitorId,
      metadata: { pp_exp: exp.id, pp_var: variant.id, pp_vid: visitorId, pp_sig: signature },
      setCookie: changed
        ? [
            setCookieHeader(
              this.cookieName,
              await signAssignment(key, state),
              this.cookieMaxAge,
              this.cookieAttrs,
            ),
          ]
        : [],
      checkoutUrl: variant.checkoutUrl ?? product.checkoutUrl ?? null,
      exposureLogged: logged,
    };
  }

  private async botQuote(productKey: string, guard: Guard): Promise<Quote> {
    const config = await this.currentConfig();
    const product = config?.products.get(productKey);
    if (product && product.currency === guard.currency && inBounds(guard, product, product.price)) {
      return priceQuote(productKey, guard, product.price, "bot", product.checkoutUrl);
    }
    return fallbackQuote(productKey, guard, "bot");
  }

  private noConfig(productKey: string, guard: Guard, scope: RequestScope | null): Quote {
    if (scope) scope.pinned = true;
    return fallbackQuote(productKey, guard, "no_config", [this.pinCookie()]);
  }

  private pinCookie(): string {
    return setCookieHeader(`${this.cookieName}_f`, "1", PIN_MAX_AGE_SECONDS, this.cookieAttrs);
  }

  private hmacKeyFor(assignmentKey: string): Promise<CryptoKey> {
    if (this.hmacCache?.raw !== assignmentKey) {
      const key = hmacKey(fromB64url(assignmentKey));
      key.catch(() => {
        if (this.hmacCache?.key === key) this.hmacCache = null;
      });
      this.hmacCache = { raw: assignmentKey, key };
    }
    return this.hmacCache.key;
  }

  /** Reports a completed purchase. Never throws. */
  async trackPurchase(input: PurchaseInput): Promise<void> {
    try {
      if (this.isOff()) return;
      const meta: Record<string, unknown> =
        typeof input.metadata === "object" && input.metadata !== null ? input.metadata : {};
      const id = (k: string) => {
        const v = own(meta, k);
        return typeof v === "string" && ID_RE.test(v) ? v : null;
      };
      const experimentId = id("pp_exp");
      const variantId = id("pp_var");
      const visitorId = id("pp_vid");
      const sig = own(meta, "pp_sig");
      this.enqueue({
        type: "purchase",
        provider: input.provider,
        orderId: idOf(input.orderId),
        amount: minorUnitsOf(input.amount),
        currency: String(input.currency).toLowerCase(),
        timestamp: timestampOf(input.timestamp),
        attribution:
          experimentId && variantId && visitorId
            ? {
                experimentId,
                variantId,
                visitorId,
                signature: typeof sig === "string" && SIG_RE.test(sig) ? sig : null,
              }
            : null,
      });
      await this.flush();
    } catch (err) {
      this.report(err);
    }
  }

  /** Reports a refund by id, or the order's cumulative refunded total. Never throws. */
  async trackRefund(input: RefundInput): Promise<void> {
    try {
      if (this.isOff()) return;
      this.enqueue({
        type: "refund",
        provider: input.provider,
        orderId: idOf(input.orderId),
        currency: String(input.currency).toLowerCase(),
        timestamp: timestampOf(input.timestamp),
        ...("refundedTotal" in input
          ? { refundedTotal: minorUnitsOf(input.refundedTotal) }
          : { refundId: idOf(input.refundId), amount: minorUnitsOf(input.amount) }),
      });
      await this.flush();
    } catch (err) {
      this.report(err);
    }
  }

  /** Sends queued events. Await it before a serverless handler returns. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = this.afterPreviousDrain(this.flushTail).then(() => this.drain());
    this.flushTail = run;
    return run;
  }

  /** Fetches the config now. */
  async refresh(): Promise<void> {
    if (this.isOff()) return;
    if (this.inflight) await waitAtMost(this.inflight, STALL_MS);
    const flight = this.startFetch({ force: true });
    if (flight) await waitAtMost(flight, STALL_MS);
  }

  /** Loads the config ahead of the first request on long-lived servers. */
  async preload(): Promise<void> {
    if (this.isOff() || this.usable(Date.now())) return;
    const flight = this.startFetch({ force: true });
    if (flight) await waitAtMost(flight, STALL_MS);
    if (!this.usable(Date.now())) this.retryAt = 0;
  }

  private usable(now: number): Config | null {
    const c = this.config;
    if (!c || now >= c.expiresAt || now - this.fetchedAt >= this.maxStaleMs) return null;
    if (this.signingKey && !this.trust.isTrusted(this.signingKey)) return null;
    return c;
  }

  private async currentConfig(): Promise<Config | null> {
    const now = Date.now();
    const ready = this.usable(now);
    this.kick(now);
    if (ready) return ready;
    const flight = this.liveFlight(now);
    if (!flight) return null;
    const remaining = this.timeoutMs - (now - this.inflightStartedAt);
    if (remaining > 0) await waitAtMost(flight, remaining);
    return this.usable(Date.now());
  }

  private kick(now: number): void {
    if (this.liveFlight(now)) return;
    if (this.serverVersion > (this.config?.version ?? 0) && now >= this.catchUpAt) {
      this.catchUpAt = now + CATCH_UP_GAP_MS;
      void this.startFetch({ unconditional: true });
    } else if (!this.usable(now) || now - this.fetchedAt >= this.refreshIntervalMs) {
      void this.startFetch();
    }
  }

  private liveFlight(now: number): Promise<void> | null {
    return this.inflight && now - this.inflightStartedAt < STALL_MS ? this.inflight : null;
  }

  private startFetch(opts: { force?: boolean; unconditional?: boolean } = {}): Promise<void> | null {
    const now = Date.now();
    const live = this.liveFlight(now);
    if (live) return live;
    if (!opts.force && now < this.retryAt) return null;
    this.inflightStartedAt = now;
    const flight: Promise<void> = this.loadConfig(opts.unconditional === true).finally(() => {
      if (this.inflight === flight) this.inflight = null;
    });
    this.inflight = flight;
    return flight;
  }

  private async loadConfig(unconditional: boolean): Promise<void> {
    try {
      const headers: Record<string, string> = {};
      if (!unconditional && this.etag && this.usable(Date.now())) headers["If-None-Match"] = this.etag;
      const res = await this.request("/v1/config", "GET", headers);
      if (res.status === 304 && headers["If-None-Match"]) {
        this.fetchedAt = Date.now();
      } else {
        if (!res.ok) throw new Error(`Leverprice config: HTTP ${res.status}${errorCode(res.body)}`);
        let envelope: unknown;
        try {
          envelope = JSON.parse(res.body);
        } catch {
          throw new Error("Leverprice config: response is not JSON");
        }
        await this.accept(envelope);
        this.etag = res.headers.get("ETag");
        this.fetchedAt = Date.now();
      }
      this.failures = 0;
      this.retryAt = 0;
      this.noteServerVersion(res.headers);
    } catch (err) {
      this.failures++;
      this.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.failures);
      this.report(err);
    }
  }

  private keyFingerprint(): Promise<string> {
    this.fingerprint ??= crypto.subtle
      .digest("SHA-256", utf8(this.secretKey ?? ""))
      .then((h) => hex(new Uint8Array(h)).slice(0, 16));
    return this.fingerprint;
  }

  private async accept(envelope: unknown): Promise<void> {
    const { config, signingKey, dropped } = await this.trust.verify(envelope, Date.now());
    // A validly signed config issued for other keys is refused even on the first load.
    if (!config.keyFingerprints.includes(await this.keyFingerprint())) {
      throw new Error("Leverprice config: not issued for this API key; refusing");
    }
    const current = this.config;
    if (current && config.projectId !== current.projectId) {
      throw new Error(
        `Leverprice config: project changed from ${current.projectId} to ${config.projectId}; refusing`,
      );
    }
    if (current && config.version < current.version) {
      throw new Error(
        `Leverprice config: refusing to roll back from version ${current.version} to ${config.version}`,
      );
    }
    if (dropped.length > 0 && config.version !== current?.version) {
      this.report(
        new Error(`Leverprice config v${config.version}: ignored malformed products ${dropped.join(", ")}`),
      );
    }
    this.config = config;
    this.signingKey = signingKey;
  }

  private noteServerVersion(headers: { get(name: string): string | null }): void {
    const v = Number(headers.get(CONFIG_VERSION_HEADER) ?? "");
    if (!Number.isSafeInteger(v) || v <= this.serverVersion) return;
    this.serverVersion = v;
    if (v > (this.config?.version ?? 0)) this.kick(Date.now());
  }

  private recordExposure(experimentId: string, variantId: string, visitorId: string): boolean {
    const k = `${experimentId}:${visitorId}`;
    if (this.exposed.has(k)) return false;
    if (this.exposed.size >= MAX_DEDUPE) this.exposed.clear();
    this.exposed.add(k);
    return this.enqueue({ type: "exposure", experimentId, variantId, visitorId, timestamp: Date.now() });
  }

  private enqueue(e: WireEvent): boolean {
    const problem = eventProblem(e);
    if (problem) {
      this.report(new Error(`Leverprice: dropped invalid ${e.type} event: ${problem}`));
      return false;
    }
    this.queue.push(e);
    this.trimQueue();
    if (this.queue.length >= AUTO_FLUSH_AT) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushIntervalMs);
      unrefTimer(this.timer);
    }
    return true;
  }

  private trimQueue(): void {
    while (this.queue.length > MAX_QUEUE) {
      const i = this.queue.findIndex((q) => q.type === "exposure");
      const [dropped] = this.queue.splice(Math.max(i, 0), 1);
      if (dropped && dropped.type !== "exposure") {
        this.report(new Error(`Leverprice: event queue full, dropped ${dropped.type} ${dropped.orderId}`));
      }
    }
  }

  private async afterPreviousDrain(previous: Promise<void>): Promise<void> {
    let settled = false;
    const done = () => {
      settled = true;
    };
    previous.then(done, done);
    while (!settled) {
      await waitAtMost(previous, 1_000);
      if (!settled && Date.now() - this.drainBeat > STALL_MS) {
        const abandoned = this.sending;
        this.sending = null;
        if (abandoned) this.requeue(abandoned);
        return;
      }
    }
  }

  private async drain(): Promise<void> {
    try {
      if (this.isOff()) return;
      for (
        let n = Math.ceil(this.queue.length / MAX_EVENTS_PER_REQUEST);
        n > 0 && this.queue.length > 0;
        n--
      ) {
        const batch = this.queue.splice(0, MAX_EVENTS_PER_REQUEST);
        this.drainBeat = Date.now();
        this.sending = batch;
        const delivered = await this.send(batch);
        if (this.sending === batch) this.sending = null;
        if (!delivered) break;
      }
    } catch (err) {
      this.report(err);
    }
  }

  private requeue(events: WireEvent[]): void {
    const money = events.filter((e) => e.type !== "exposure");
    if (money.length === 0) return;
    this.queue.unshift(...money);
    this.trimQueue();
  }

  private async send(events: WireEvent[]): Promise<boolean> {
    const body = JSON.stringify({ events, sdk: { name: "@leverprice/sdk", version: SDK_VERSION } });
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SEND_ATTEMPTS && !this.isOff(); attempt++) {
      if (attempt > 0) await sleep(250 * 4 ** (attempt - 1));
      this.drainBeat = Date.now();
      try {
        const res = await this.request("/v1/events", "POST", { "Content-Type": "application/json" }, body);
        this.noteServerVersion(res.headers);
        if (res.ok) return true;
        if (res.status < 500 && res.status !== 408 && res.status !== 429) {
          this.report(new Error(`Leverprice events rejected: HTTP ${res.status} ${res.body.slice(0, 300)}`));
          return true;
        }
        lastError = new Error(`Leverprice events: HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    if (this.sending === events) this.requeue(events);
    if (lastError) this.report(lastError);
    return false;
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    headers: Record<string, string>,
    body?: string,
  ): Promise<ApiResponse> {
    const ctrl = new AbortController();
    let fail: (error: Error) => void = noop;
    const timeout = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const timer = setTimeout(() => {
      ctrl.abort();
      fail(new Error(`Leverprice: ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
    unrefTimer(timer);
    const call = (async (): Promise<ApiResponse> => {
      const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: {
          ...headers,
          Authorization: `Bearer ${this.secretKey}`,
          "User-Agent": `leverprice-sdk-js/${SDK_VERSION}`,
        },
        ...(body === undefined ? {} : { body }),
        signal: ctrl.signal,
      });
      return { status: res.status, ok: res.ok, headers: res.headers, body: await res.text() };
    })();
    call.catch(noop);
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private isOff(): boolean {
    return this.disabled || this.secretKey === null || envDisabled();
  }

  private report(err: unknown): void {
    if (!this.isOff()) this.emit(err);
  }

  private emit(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    try {
      if (this.onError) this.onError(e);
      else console.warn(e.message);
    } catch {
      // A failing error handler must not affect pricing.
    }
  }
}

function envDisabled(): boolean {
  try {
    const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env;
    const v = env?.LEVERPRICE_DISABLED?.trim().toLowerCase();
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

function normalizeGuards(products: Record<string, ProductGuard>): Map<string, Guard> {
  const out = new Map<string, Guard>();
  for (const [key, g] of Object.entries(products ?? {})) {
    const where = `Leverprice: products.${key}`;
    if (typeof g?.currency !== "string" || !/^[A-Za-z]{3}$/.test(g.currency)) {
      throw new Error(`${where}.currency must be an ISO 4217 code such as "usd"`);
    }
    if (!Number.isSafeInteger(g.fallbackPrice) || g.fallbackPrice <= 0) {
      throw new Error(`${where}.fallbackPrice must be a positive integer (minor units)`);
    }
    const minPrice = g.minPrice ?? 1;
    const maxPrice = g.maxPrice ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(minPrice) || !Number.isSafeInteger(maxPrice) || minPrice > maxPrice) {
      throw new Error(`${where}: minPrice and maxPrice must be integers with minPrice <= maxPrice`);
    }
    out.set(key, { currency: g.currency.toLowerCase(), fallbackPrice: g.fallbackPrice, minPrice, maxPrice });
  }
  return out;
}

function inBounds(guard: Guard, product: ConfigProduct, price: number): boolean {
  return (
    Number.isSafeInteger(price) &&
    price > 0 &&
    price >= Math.max(guard.minPrice, product.minPrice) &&
    price <= Math.min(guard.maxPrice, product.maxPrice)
  );
}

function fallbackQuote(
  productKey: string,
  guard: Guard,
  reason: QuoteReason,
  setCookie: string[] = [],
): Quote {
  return {
    productKey,
    price: guard.fallbackPrice,
    currency: guard.currency,
    isFallback: true,
    reason,
    experimentId: null,
    variantId: null,
    visitorId: null,
    metadata: {},
    setCookie,
    checkoutUrl: null,
    exposureLogged: false,
  };
}

function priceQuote(
  productKey: string,
  guard: Guard,
  price: number,
  reason: "base_price" | "bot",
  checkoutUrl: string | undefined,
): Quote {
  return {
    ...fallbackQuote(productKey, guard, reason),
    price,
    isFallback: false,
    checkoutUrl: checkoutUrl ?? null,
  };
}

function normalizeUserId(userId: unknown): string | null {
  if (typeof userId === "number") return Number.isSafeInteger(userId) ? String(userId) : null;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

function minorUnitsOf(amount: unknown): number {
  return typeof amount === "number" ? Math.round(amount) : Number.NaN;
}

function idOf(id: unknown): string {
  return typeof id === "string" ? id : typeof id === "number" ? String(id) : "";
}

function timestampOf(t: number | null | undefined): number {
  if (t === undefined || t === null) return Date.now();
  return Math.round(t < 1e12 ? t * 1000 : t);
}

function errorCode(body: string): string {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "string" ? ` (${code})` : "";
  } catch {
    return "";
  }
}
