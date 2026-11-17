import { fromB64url, fromUtf8, isRecord } from "./util.ts";

export const PROTOCOL_VERSION = 2;
export const CONFIG_VERSION_HEADER = "Leverprice-Config-Version";
export const MAX_EVENTS_PER_REQUEST = 500;
export const PROVIDERS = ["stripe", "polar", "lemonsqueezy", "dodo", "other"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface SignedKeyset {
  payload: string;
  signature: string;
  rootKeyId: string;
}

export interface Keyset {
  schema: 1;
  version: number;
  issuedAt: number;
  expiresAt: number | null;
  keys: { id: string; publicKey: string }[];
}

export interface SignedConfig {
  payload: string;
  signature: string;
  keyId: string;
  keyset: SignedKeyset;
}

export interface ConfigVariant {
  id: string;
  price: number;
  weight: number;
  checkoutUrl?: string;
}

export interface ConfigProduct {
  id: string;
  currency: string;
  price: number;
  minPrice: number;
  maxPrice: number;
  checkoutUrl?: string;
  experiment: null | { id: string; salt: string; variants: ConfigVariant[] };
}

export interface Config {
  projectId: string;
  version: number;
  issuedAt: number;
  expiresAt: number;
  assignmentKey: string;
  keyFingerprints: string[];
  products: Map<string, ConfigProduct>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const isAmount = (v: unknown): v is number => Number.isSafeInteger(v);
const httpsUrl = (v: unknown): string | undefined =>
  typeof v === "string" && /^https:\/\/[^\s]+$/i.test(v) ? v : undefined;

export function parseConfig(payload: string): { config: Config; dropped: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(fromUtf8(fromB64url(payload)));
  } catch {
    throw new Error("Leverprice config: payload is not base64url JSON");
  }
  if (!isRecord(raw)) throw new Error("Leverprice config: payload is not an object");
  if (raw.schema !== PROTOCOL_VERSION) {
    throw new Error(
      `Leverprice config: unsupported schema ${String(raw.schema)} (this SDK speaks schema ${PROTOCOL_VERSION})`,
    );
  }
  const { projectId, version, issuedAt, expiresAt, assignmentKey, keyFingerprints, products } = raw;
  if (
    !Array.isArray(keyFingerprints) ||
    !keyFingerprints.every((f) => typeof f === "string" && /^[0-9a-f]{16}$/.test(f))
  ) {
    throw new Error("Leverprice config: bad keyFingerprints");
  }
  if (typeof projectId !== "string" || projectId.length === 0)
    throw new Error("Leverprice config: no projectId");
  if (!Number.isSafeInteger(version) || (version as number) < 0)
    throw new Error("Leverprice config: bad version");
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new Error("Leverprice config: bad expiresAt");
  }
  if (typeof assignmentKey !== "string" || keyLength(assignmentKey) < 32) {
    throw new Error("Leverprice config: assignmentKey must be at least 32 bytes of base64url");
  }
  if (!isRecord(products)) throw new Error("Leverprice config: no products");

  const out = new Map<string, ConfigProduct>();
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(products)) {
    const product = parseProduct(value);
    if (product) out.set(key, product);
    else dropped.push(key);
  }
  return {
    config: {
      projectId,
      version: version as number,
      issuedAt: typeof issuedAt === "number" ? issuedAt : 0,
      expiresAt,
      assignmentKey,
      keyFingerprints: keyFingerprints as string[],
      products: out,
    },
    dropped,
  };
}

function keyLength(b64: string): number {
  try {
    return fromB64url(b64).length;
  } catch {
    return 0;
  }
}

function parseProduct(p: unknown): ConfigProduct | null {
  if (!isRecord(p)) return null;
  const { currency, price, minPrice, maxPrice } = p;
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return null;
  if (!isAmount(price) || !isAmount(minPrice) || !isAmount(maxPrice)) return null;
  let experiment: ConfigProduct["experiment"] = null;
  if (p.experiment !== null && p.experiment !== undefined) {
    const e = p.experiment;
    if (!isRecord(e) || !isId(e.id) || typeof e.salt !== "string" || !Array.isArray(e.variants)) return null;
    const variants: ConfigVariant[] = [];
    for (const v of e.variants as unknown[]) {
      if (!isRecord(v) || !isId(v.id) || !isAmount(v.price) || !isAmount(v.weight) || v.weight < 0)
        return null;
      const checkoutUrl = httpsUrl(v.checkoutUrl);
      variants.push({ id: v.id, price: v.price, weight: v.weight, ...(checkoutUrl ? { checkoutUrl } : {}) });
    }
    experiment = { id: e.id, salt: e.salt, variants };
  }
  const checkoutUrl = httpsUrl(p.checkoutUrl);
  return {
    id: typeof p.id === "string" ? p.id : "",
    currency: currency.toLowerCase(),
    price,
    minPrice,
    maxPrice,
    ...(checkoutUrl ? { checkoutUrl } : {}),
    experiment,
  };
}

export interface WireAttribution {
  experimentId: string;
  variantId: string;
  visitorId: string;
  signature: string | null;
}

export type WireEvent =
  | { type: "exposure"; experimentId: string; variantId: string; visitorId: string; timestamp: number }
  | {
      type: "purchase";
      provider: ProviderName;
      orderId: string;
      amount: number;
      currency: string;
      timestamp: number;
      attribution: WireAttribution | null;
    }
  | {
      type: "refund";
      provider: ProviderName;
      orderId: string;
      currency: string;
      timestamp: number;
      refundId?: string;
      amount?: number;
      refundedTotal?: number;
    };

const MAX_MINOR_UNITS = 100_000_000_00;
const SIGNATURE_RE = /^[0-9a-f]{16}$/;
const isMinorUnits = (v: unknown) =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_MINOR_UNITS;
const isText = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 255;

export function eventProblem(e: WireEvent): string | null {
  if (!Number.isSafeInteger(e.timestamp) || e.timestamp <= 0)
    return "timestamp must be a positive integer (ms)";
  if (e.type === "exposure") {
    return isId(e.experimentId) && isId(e.variantId) && isId(e.visitorId)
      ? null
      : "invalid experiment/variant/visitor id";
  }
  if (!(PROVIDERS as readonly string[]).includes(e.provider))
    return `unknown provider "${String(e.provider)}"`;
  if (!isText(e.orderId)) return "orderId must be a string of 1–255 characters";
  if (!/^[a-z]{3}$/.test(e.currency)) return "currency must be a 3-letter ISO 4217 code";
  if (e.type === "purchase") {
    if (!isMinorUnits(e.amount)) return "amount must be a non-negative integer in minor units";
    const a = e.attribution;
    if (
      a &&
      !(
        isId(a.experimentId) &&
        isId(a.variantId) &&
        isId(a.visitorId) &&
        (a.signature === null || SIGNATURE_RE.test(a.signature))
      )
    ) {
      return "invalid attribution";
    }
    return null;
  }
  if (e.refundId !== undefined && !isText(e.refundId)) return "refundId must be a string of 1–255 characters";
  if (e.amount !== undefined && !isMinorUnits(e.amount)) return "amount must be a non-negative integer";
  if (e.refundedTotal !== undefined && !isMinorUnits(e.refundedTotal)) {
    return "refundedTotal must be a non-negative integer";
  }
  if (!(e.refundId !== undefined && e.amount !== undefined) && e.refundedTotal === undefined) {
    return "refund needs refundId + amount, or refundedTotal";
  }
  return null;
}
