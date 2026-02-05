// Minimal JWT (HS256) helpers for Cloudflare Workers.
// Uses Web Crypto API (crypto.subtle) for HMAC-SHA256 signing / verification.

import { Effect, Schema } from "effect";

export type JwtPayload = Record<string, unknown> & { exp?: number };

export class JwtDecodeError extends Schema.TaggedError<JwtDecodeError>()("JwtDecodeError", {
  reason: Schema.String,
  input: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect),
}) {}

export class JwtCryptoError extends Schema.TaggedError<JwtCryptoError>()("JwtCryptoError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

export type JwtError = JwtDecodeError | JwtCryptoError;

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
const textDecoder = new TextDecoder();

const base64UrlEncode = (data: ArrayBuffer | Uint8Array): string => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  // btoa is available in Workers (and via nodejs_compat).
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const base64UrlDecodeToBytes = (s: string): Effect.Effect<Uint8Array, JwtDecodeError> =>
  Effect.gen(function* () {
    // Base64url strings commonly omit `=` padding. `atob` expects correct padding.
    // Padding needed is: (4 - (len % 4)) % 4.
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const mod = normalized.length % 4;

    // base64 strings should never have length % 4 === 1.
    if (mod === 1) {
      return yield* JwtDecodeError.make({ reason: "Invalid base64url string", input: s });
    }

    const padded = normalized + "=".repeat((4 - mod) % 4);
    const binary = yield* Effect.try({
      try: () => atob(padded),
      catch: (cause) =>
        JwtDecodeError.make({
          reason: "Invalid base64url string",
          input: s,
          cause,
        }),
    });

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  });

const importHmacKey = (
  secret: string,
  usages: KeyUsage[],
): Effect.Effect<CryptoKey, JwtCryptoError> =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        textEncoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        usages,
      ),
    catch: (cause) => JwtCryptoError.make({ operation: "importKey", cause }),
  });

export const signJwt = (
  payload: JwtPayload,
  secret: string,
): Effect.Effect<string, JwtCryptoError> =>
  Effect.gen(function* () {
    const header = { alg: "HS256", typ: "JWT" } as const;

    const headerJson = yield* Effect.try({
      try: () => JSON.stringify(header),
      catch: (cause) => JwtCryptoError.make({ operation: "stringifyHeader", cause }),
    });

    const payloadJson = yield* Effect.try({
      try: () => JSON.stringify(payload),
      catch: (cause) => JwtCryptoError.make({ operation: "stringifyPayload", cause }),
    });

    const headerPart = base64UrlEncode(textEncoder.encode(headerJson));
    const payloadPart = base64UrlEncode(textEncoder.encode(payloadJson));
    const signingInput = `${headerPart}.${payloadPart}`;

    const key = yield* importHmacKey(secret, ["sign"]);

    const signatureInput = textEncoder.encode(signingInput);
    const signature = yield* Effect.tryPromise({
      try: () => crypto.subtle.sign("HMAC", key, signatureInput),
      catch: (cause) => JwtCryptoError.make({ operation: "sign", cause }),
    });

    const signaturePart = base64UrlEncode(signature);
    return `${signingInput}.${signaturePart}`;
  });

export const verifyJwt = (
  token: string,
  secret: string,
): Effect.Effect<JwtPayload | null, JwtError> =>
  Effect.gen(function* () {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerPart, payloadPart, signaturePart] = parts;

    const header = yield* base64UrlDecodeToBytes(headerPart).pipe(
      Effect.map((bytes) => textDecoder.decode(bytes)),
      Effect.flatMap((json) =>
        Effect.try({
          try: () => JSON.parse(json) as unknown,
          catch: (cause) =>
            JwtDecodeError.make({
              reason: "Invalid JWT header JSON",
              input: headerPart,
              cause,
            }),
        }),
      ),
    );

    const payload = yield* base64UrlDecodeToBytes(payloadPart).pipe(
      Effect.map((bytes) => textDecoder.decode(bytes)),
      Effect.flatMap((json) =>
        Effect.try({
          try: () => JSON.parse(json) as unknown,
          catch: (cause) =>
            JwtDecodeError.make({
              reason: "Invalid JWT payload JSON",
              input: payloadPart,
              cause,
            }),
        }),
      ),
    );

    if (
      typeof header !== "object" ||
      header === null ||
      (header as Record<string, unknown>).alg !== "HS256"
    ) {
      return null;
    }

    if (typeof payload !== "object" || payload === null) return null;

    const signingInput = `${headerPart}.${payloadPart}`;
    const signatureBytes = yield* base64UrlDecodeToBytes(signaturePart);

    const key = yield* importHmacKey(secret, ["verify"]);

    const verifyInput = textEncoder.encode(signingInput);
    const ok = yield* Effect.tryPromise({
      try: () => crypto.subtle.verify("HMAC", key, signatureBytes, verifyInput),
      catch: (cause) => JwtCryptoError.make({ operation: "verify", cause }),
    });

    if (!ok) return null;

    const p = payload as JwtPayload;
    if (typeof p.exp === "number") {
      const now = Math.floor(Date.now() / 1000);
      if (p.exp <= now) return null;
    }

    return p;
  });
