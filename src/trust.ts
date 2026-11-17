import { ed25519Verify, fromB64url, fromUtf8, isRecord, own } from "./util.ts";
import { type Config, type Keyset, parseConfig } from "./wire.ts";

export const ROOT_KEY_PLACEHOLDER = "REPLACE_WITH_ROOT_PUBLIC_KEY";

export interface SigningKey {
  id: string;
  publicKey: string;
}

export interface VerifiedConfig {
  config: Config;
  signingKey: SigningKey;
  dropped: string[];
}

export class TrustChain {
  private newest: Keyset | null = null;
  private readonly verified = new Map<string, Keyset>();

  constructor(
    private readonly rootKeys: Record<string, string>,
    private readonly minKeysetVersion: number,
  ) {}

  get keysetVersion(): number {
    return this.newest?.version ?? 0;
  }

  isTrusted(key: SigningKey): boolean {
    return !this.newest || this.newest.keys.some((k) => k.id === key.id && k.publicKey === key.publicKey);
  }

  async verify(envelope: unknown, now: number): Promise<VerifiedConfig> {
    if (!isRecord(envelope)) throw new Error("Leverprice config: response is not a signed config");
    const { payload, signature, keyId } = envelope;
    if (typeof payload !== "string" || typeof signature !== "string" || typeof keyId !== "string") {
      throw new Error("Leverprice config: response is not a signed config");
    }
    const keyset = await this.verifyKeyset(envelope.keyset, now);
    const key = keyset.keys.find((k) => k.id === keyId);
    if (!key)
      throw new Error(`Leverprice config: signing key "${keyId}" is not in keyset v${keyset.version}`);
    if (!(await ed25519Verify(key.publicKey, signature, payload))) {
      throw new Error(`Leverprice config: bad signature (key "${keyId}")`);
    }
    const { config, dropped } = parseConfig(payload);
    if (now >= config.expiresAt) {
      throw new Error(
        `Leverprice config v${config.version}: expired at ${new Date(config.expiresAt).toISOString()}`,
      );
    }
    return { config, signingKey: { id: key.id, publicKey: key.publicKey }, dropped };
  }

  private async verifyKeyset(signed: unknown, now: number): Promise<Keyset> {
    if (
      !isRecord(signed) ||
      typeof signed.payload !== "string" ||
      typeof signed.signature !== "string" ||
      typeof signed.rootKeyId !== "string"
    ) {
      throw new Error("Leverprice keyset: missing or malformed");
    }
    let keyset = this.verified.get(signed.payload);
    if (!keyset) {
      const root = own(this.rootKeys, signed.rootKeyId);
      if (!root)
        throw new Error(`Leverprice keyset: root key "${signed.rootKeyId}" is not trusted by this SDK`);
      if (root === ROOT_KEY_PLACEHOLDER) {
        throw new Error(
          "Leverprice: this SDK build has no root public key (ROOT_PUBLIC_KEYS is a placeholder); pass trustedRootKeys",
        );
      }
      if (!(await ed25519Verify(root, signed.signature, signed.payload))) {
        throw new Error(`Leverprice keyset: signature does not match root key "${signed.rootKeyId}"`);
      }
      keyset = parseKeyset(signed.payload);
      if (this.verified.size >= 8) this.verified.clear();
      this.verified.set(signed.payload, keyset);
    }
    if (keyset.expiresAt !== null && now >= keyset.expiresAt) {
      throw new Error(`Leverprice keyset v${keyset.version}: expired`);
    }
    if (keyset.version < this.minKeysetVersion) {
      throw new Error(
        `Leverprice keyset v${keyset.version}: below the minimum version ${this.minKeysetVersion}`,
      );
    }
    if (this.newest && keyset.version < this.newest.version) {
      throw new Error(
        `Leverprice keyset v${keyset.version}: older than v${this.newest.version} already seen (revoked keys cannot come back)`,
      );
    }
    if (!this.newest || keyset.version > this.newest.version) this.newest = keyset;
    return keyset;
  }
}

function parseKeyset(payload: string): Keyset {
  let raw: unknown;
  try {
    raw = JSON.parse(fromUtf8(fromB64url(payload)));
  } catch {
    throw new Error("Leverprice keyset: payload is not base64url JSON");
  }
  if (!isRecord(raw) || raw.schema !== 1 || !Number.isSafeInteger(raw.version) || !Array.isArray(raw.keys)) {
    throw new Error("Leverprice keyset: unsupported schema");
  }
  const keys: Keyset["keys"] = [];
  for (const k of raw.keys as unknown[]) {
    if (isRecord(k) && typeof k.id === "string" && typeof k.publicKey === "string") {
      keys.push({ id: k.id, publicKey: k.publicKey });
    }
  }
  return {
    schema: 1,
    version: raw.version as number,
    issuedAt: typeof raw.issuedAt === "number" ? raw.issuedAt : 0,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : null,
    keys,
  };
}
