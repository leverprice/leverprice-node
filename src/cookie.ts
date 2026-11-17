import { b64url, fromB64url, fromUtf8, hmac, isRecord, timingSafeEqual, utf8 } from "./util.ts";

export const MAX_COOKIE_EXPERIMENTS = 10;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VISITOR_KEY_RE = /^[0-9a-f]{32}$/;
const MAX_COOKIE_LENGTH = 4096;

export interface AssignmentState {
  v: string;
  a: Record<string, string>;
  x: string[];
}

export interface CookieAttributes {
  secure: boolean;
  domain?: string | undefined;
}

export function newAssignmentState(v: string): AssignmentState {
  return { v, a: {}, x: [] };
}

export function cloneState(s: AssignmentState): AssignmentState {
  return { v: s.v, a: { ...s.a }, x: [...s.x] };
}

export function assign(state: AssignmentState, experimentId: string, variantId: string): void {
  const rest = Object.entries(state.a).filter(([id]) => id !== experimentId);
  state.a = Object.fromEntries([[experimentId, variantId], ...rest].slice(0, MAX_COOKIE_EXPERIMENTS));
  state.x = state.x.filter((id) => Object.hasOwn(state.a, id));
}

export function markExposed(state: AssignmentState, experimentId: string): boolean {
  if (state.x.includes(experimentId)) return false;
  state.x = [experimentId, ...state.x]
    .filter((id) => Object.hasOwn(state.a, id))
    .slice(0, MAX_COOKIE_EXPERIMENTS);
  return true;
}

export async function signAssignment(key: CryptoKey, state: AssignmentState): Promise<string> {
  const body = b64url(utf8(JSON.stringify({ v: state.v, a: state.a, x: state.x })));
  const sig = b64url((await hmac(key, `pp:cookie:v1:${body}`)).slice(0, 16));
  return `${body}.${sig}`;
}

export async function verifyAssignment(key: CryptoKey, raw: string): Promise<AssignmentState | null> {
  if (raw.length > MAX_COOKIE_LENGTH) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{22}$/.test(sig)) return null;
  try {
    const expected = (await hmac(key, `pp:cookie:v1:${body}`)).slice(0, 16);
    if (!timingSafeEqual(expected, fromB64url(sig))) return null;
    return normalizeState(JSON.parse(fromUtf8(fromB64url(body))));
  } catch {
    return null;
  }
}

function normalizeState(raw: unknown): AssignmentState | null {
  if (!isRecord(raw) || typeof raw.v !== "string" || !VISITOR_KEY_RE.test(raw.v) || !isRecord(raw.a))
    return null;
  const a: Record<string, string> = {};
  for (const [exp, variant] of Object.entries(raw.a).slice(0, MAX_COOKIE_EXPERIMENTS)) {
    if (ID_RE.test(exp) && typeof variant === "string" && ID_RE.test(variant)) a[exp] = variant;
  }
  const x = Array.isArray(raw.x)
    ? raw.x
        .filter((id): id is string => typeof id === "string" && Object.hasOwn(a, id))
        .slice(0, MAX_COOKIE_EXPERIMENTS)
    : [];
  return { v: raw.v, a, x };
}

export function setCookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
  attrs: CookieAttributes,
): string {
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${maxAgeSeconds}`, "SameSite=Lax", "HttpOnly"];
  if (attrs.secure) parts.push("Secure");
  if (attrs.domain) parts.push(`Domain=${attrs.domain}`);
  return parts.join("; ");
}
