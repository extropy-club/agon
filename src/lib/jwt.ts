// Minimal JWT (HS256) helpers for Cloudflare Workers.
// Uses Web Crypto API (crypto.subtle) for HMAC-SHA256 signing / verification.

export type JwtPayload = Record<string, unknown> & { exp?: number };

// tsgo's lib set does not always include DOM's `KeyUsage`.
type KeyUsage =
  | "encrypt"
  | "decrypt"
  | "sign"
  | "verify"
  | "deriveKey"
  | "deriveBits"
  | "wrapKey"
  | "unwrapKey";

const textEncoder = new TextEncoder();

const base64UrlEncode = (data: ArrayBuffer | Uint8Array): string => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  // btoa is available in Workers (and via nodejs_compat).
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const base64UrlDecodeToBytes = (s: string): Uint8Array => {
  // Base64url strings commonly omit `=` padding. `atob` expects correct padding.
  // Padding needed is: (4 - (len % 4)) % 4.
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const mod = normalized.length % 4;

  // base64 strings should never have length % 4 === 1.
  if (mod === 1) {
    throw new Error("Invalid base64url string");
  }

  const padded = normalized + "=".repeat((4 - mod) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const importHmacKey = async (secret: string, usages: KeyUsage[]): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );

export const signJwt = async (payload: JwtPayload, secret: string): Promise<string> => {
  const header = { alg: "HS256", typ: "JWT" } as const;

  const headerPart = base64UrlEncode(textEncoder.encode(JSON.stringify(header)));
  const payloadPart = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerPart}.${payloadPart}`;

  const key = await importHmacKey(secret, ["sign"]);
  const signatureInput = textEncoder.encode(signingInput);
  const signature = await crypto.subtle.sign("HMAC", key, signatureInput);

  const signaturePart = base64UrlEncode(signature);
  return `${signingInput}.${signaturePart}`;
};

export const verifyJwt = async (token: string, secret: string): Promise<JwtPayload | null> => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerPart, payloadPart, signaturePart] = parts;

    let header: unknown;
    let payload: unknown;
    try {
      header = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(headerPart)));
      payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeToBytes(payloadPart)));
    } catch {
      return null;
    }

    if (
      typeof header !== "object" ||
      header === null ||
      (header as Record<string, unknown>).alg !== "HS256"
    ) {
      return null;
    }

    if (typeof payload !== "object" || payload === null) return null;

    const signingInput = `${headerPart}.${payloadPart}`;
    const signatureBytes = base64UrlDecodeToBytes(signaturePart);

    const key = await importHmacKey(secret, ["verify"]);
    const verifyInput = textEncoder.encode(signingInput);
    const ok = await crypto.subtle.verify("HMAC", key, signatureBytes, verifyInput);
    if (!ok) return null;

    const p = payload as JwtPayload;
    if (typeof p.exp === "number") {
      const now = Math.floor(Date.now() / 1000);
      if (p.exp <= now) return null;
    }

    return p;
  } catch {
    return null;
  }
};
