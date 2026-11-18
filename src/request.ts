export interface FetchRequestLike {
  readonly headers: { get(name: string): string | null };
}

export interface NodeRequestLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export type RequestLike = FetchRequestLike | NodeRequestLike;

/** Header names are ASCII: Unicode case mapping would let U+212A stand in for "k". */
const asciiLower = (name: string) => name.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());

export function readHeader(request: RequestLike | null | undefined, name: string): string | null {
  const headers: unknown = request?.headers;
  if (typeof headers !== "object" || headers === null) return null;
  const lower = name.toLowerCase();
  if ("get" in headers && typeof headers.get === "function") {
    try {
      const value: unknown = headers.get(lower);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  const record = headers as Record<string, unknown>;
  let value = Object.hasOwn(record, lower) ? record[lower] : undefined;
  if (value === undefined) {
    for (const key of Object.keys(record)) {
      if (key.length === lower.length && asciiLower(key) === lower) {
        value = record[key];
        break;
      }
    }
  }
  if (Array.isArray(value)) {
    const parts = value.filter((v): v is string => typeof v === "string");
    return parts.length > 0 ? parts.join(lower === "cookie" ? "; " : ", ") : null;
  }
  return typeof value === "string" ? value : null;
}

// Fetch `Headers` joins repeated headers with ", ", so values are split on commas too.
export function cookieValues(header: string | null | undefined, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(/[;,]/)) {
    const eq = part.indexOf("=");
    if (eq <= 0 || part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.includes("%")) {
      try {
        value = decodeURIComponent(value);
      } catch {
        // Kept raw: it fails verification.
      }
    }
    if (value) out.push(value);
  }
  return out;
}

const PURPOSE_RE = /prefetch|prerender|preview/i;

export function isPrefetch(request: RequestLike | null | undefined): boolean {
  if (!request) return false;
  for (const name of ["sec-purpose", "x-sec-purpose", "purpose", "x-purpose", "x-moz"]) {
    const value = readHeader(request, name);
    if (value && PURPOSE_RE.test(value)) return true;
  }
  return readHeader(request, "next-router-prefetch") === "1";
}

/** Values CDNs send when they don't know the country, or it isn't one. */
const NOT_A_COUNTRY = new Set(["XX", "ZZ", "T1", "A1", "A2", "AP", "EU"]);

/** Two ASCII letters, with ASCII whitespace around them at most: case mapping never invents a code. */
const COUNTRY_RE = /^[ \t\n\v\f\r]*([A-Za-z]{2})[ \t\n\v\f\r]*$/;

export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = COUNTRY_RE.exec(value)?.[1]?.toUpperCase();
  return code !== undefined && !NOT_A_COUNTRY.has(code) ? code : null;
}

/**
 * Headers every browser or client sends itself: never a source for the visitor's country, since
 * a visitor could pick their own price with them. The same rule as the dashboard's.
 */
export function visitorSetHeader(name: string): boolean {
  const lower = name.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
  return /^(sec-|accept|content-|if-|x-forwarded-|proxy-)/.test(lower) || VISITOR_SET_HEADERS.has(lower);
}

const VISITOR_SET_HEADERS = new Set([
  "authorization",
  "cache-control",
  "connection",
  "cookie",
  "dnt",
  "forwarded",
  "host",
  "origin",
  "pragma",
  "priority",
  "purpose",
  "range",
  "referer",
  "te",
  "upgrade-insecure-requests",
  "user-agent",
  "via",
  "x-real-ip",
  "x-requested-with",
]);

/**
 * Headers proxies and hosts set to the visitor's IP address, in the order they are read. Only a
 * visitor without a cookie is told apart by it, so a forged one picks no more than clearing cookies.
 */
const ADDRESS_HEADERS = [
  "cf-connecting-ip",
  "true-client-ip",
  "fastly-client-ip",
  "fly-client-ip",
  "x-real-ip",
  "x-forwarded-for",
];

/** The visitor's address: the first address header that holds one, else the connection's. */
export function clientAddress(request: RequestLike | null | undefined): string | null {
  if (!request) return null;
  for (const name of ADDRESS_HEADERS) {
    const value = readHeader(request, name);
    if (value === null) continue;
    const address = normalizeAddress(value.split(",")[0]);
    if (address !== null) return address;
  }
  return normalizeAddress(connectionAddress(request));
}

/** Node's `IncomingMessage` (and Express) carry the peer's address on the socket. */
function connectionAddress(request: object): string | null {
  try {
    const own = (request as { ip?: unknown }).ip;
    if (typeof own === "string") return own;
    const socket = (request as { socket?: { remoteAddress?: unknown } }).socket;
    return typeof socket?.remoteAddress === "string" ? socket.remoteAddress : null;
  } catch {
    return null;
  }
}

const IPV4_RE = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/;
const HEX_GROUP_RE = /^[0-9A-Fa-f]{1,4}$/;

function ipv4(text: string): number[] | null {
  const m = IPV4_RE.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function ipv6(text: string): number[] | null {
  let s = text;
  if (s.includes(".")) {
    const colon = s.lastIndexOf(":");
    const v4 = ipv4(s.slice(colon + 1));
    if (colon < 0 || !v4) return null;
    s = `${s.slice(0, colon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const groups = [...head, ...(tail ?? [])];
  if (!groups.every((g) => HEX_GROUP_RE.test(g))) return null;
  const parse = (g: string) => Number.parseInt(g, 16);
  if (tail === null) return groups.length === 8 ? groups.map(parse) : null;
  if (groups.length > 7) return null;
  return [...head.map(parse), ...Array<number>(8 - groups.length).fill(0), ...tail.map(parse)];
}

/**
 * An address in one spelling: IPv4 in decimal (`203.0.113.7`), IPv6 cut to its /64 network as four
 * lowercase hex groups (`2001:db8:0:1`), since phones change the rest of it every day. Accepts a
 * port (`203.0.113.7:443`, `[2001:db8::1]:443`), brackets and a zone (`%eth0`); null otherwise.
 */
export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let s = value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end < 0 || (end + 1 < s.length && !/^:[0-9]{1,5}$/.test(s.slice(end + 1)))) return null;
    s = s.slice(1, end);
  } else if (/^[0-9.]+:[0-9]{1,5}$/.test(s)) {
    s = s.slice(0, s.indexOf(":"));
  }
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = ipv4(s);
  if (v4) return v4.join(".");
  const v6 = ipv6(s);
  if (!v6) return null;
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
    return [v6[6]! >> 8, v6[6]! & 255, v6[7]! >> 8, v6[7]! & 255].join(".");
  }
  return v6
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":");
}

export interface RequestInput {
  request?: RequestLike | null;
  cookie?: string | null;
  userAgent?: string | null;
  country?: string | null;
}

export interface RequestInfo {
  cookieInput: string | null;
  assignmentCookies: string[];
  pinned: boolean;
  userAgent: string | null;
  prefetch: boolean;
  country: string | null;
}

export function readRequest(
  input: RequestInput,
  cookieName: string,
  countryHeader: string | null = null,
): RequestInfo {
  const request = input.request ?? null;
  const explicit = typeof input.cookie === "string" ? input.cookie : null;
  const cookieInput = explicit ?? readHeader(request, "cookie");
  let assignmentCookies: string[];
  let pinned = false;
  if (explicit !== null && !explicit.includes("=")) {
    assignmentCookies = explicit.trim() ? [explicit.trim()] : [];
  } else {
    assignmentCookies = cookieValues(cookieInput, cookieName);
    pinned = cookieValues(cookieInput, `${cookieName}_f`).length > 0;
  }
  const userAgent = typeof input.userAgent === "string" ? input.userAgent : readHeader(request, "user-agent");
  const country = normalizeCountry(
    typeof input.country === "string"
      ? input.country
      : countryHeader
        ? readHeader(request, countryHeader)
        : null,
  );
  return { cookieInput, assignmentCookies, pinned, userAgent, prefetch: isPrefetch(request), country };
}
