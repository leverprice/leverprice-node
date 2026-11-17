const enc = new TextEncoder();
const dec = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;
export const utf8 = (s: string): Bytes => enc.encode(s) as Bytes;
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(input: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error("invalid base64url");
  const bin = atob(input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

export function randomHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return hex(b);
}

export function hmacKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmac(key: CryptoKey, data: string): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(data)));
}

export async function hmacHex(key: CryptoKey, data: string, chars: number): Promise<string> {
  return hex(await hmac(key, data)).slice(0, chars);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export async function ed25519Verify(publicKey: string, signature: string, data: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromB64url(publicKey), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64url(signature), utf8(data));
  } catch {
    return false;
  }
}

export async function bucketFor(salt: string, visitorId: string): Promise<number> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(`${salt}:${visitorId}`)));
  return (((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0) % 10_000;
}

export function pickVariant<V extends { weight: number }>(variants: V[], bucket: number): V {
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (bucket < acc) return v;
  }
  return variants[variants.length - 1]!;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function own<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

export function unrefTimer(timer: unknown): void {
  try {
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    } else if (typeof timer === "number") {
      (globalThis as unknown as { Deno?: { unrefTimer?: (id: number) => void } }).Deno?.unrefTimer?.(timer);
    }
  } catch {}
}
