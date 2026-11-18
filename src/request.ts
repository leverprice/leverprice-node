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
