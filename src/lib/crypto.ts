// Minimal AES-256-GCM helpers for Cloudflare Workers (Web Crypto API).
//
// Encrypted payload format: base64(iv + ciphertext + tag)
// - iv: 12 bytes (96-bit) random
// - ciphertext: variable
// - tag: appended by Web Crypto to ciphertext (16 bytes for AES-GCM)

import { Effect, Schema } from "effect";

export class CryptoError extends Schema.TaggedError<CryptoError>()("CryptoError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

export class DecryptionError extends Schema.TaggedError<DecryptionError>()("DecryptionError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

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

const base64Encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const base64DecodeToBytes = (s: string): Effect.Effect<Uint8Array, DecryptionError> =>
  Effect.gen(function* () {
    const binary = yield* Effect.try({
      try: () => atob(s),
      catch: (cause) =>
        DecryptionError.make({
          reason: "Invalid base64 string",
          cause,
        }),
    });

    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  });

export const deriveKey = (secret: string): Effect.Effect<CryptoKey, CryptoError> =>
  Effect.gen(function* () {
    // Derive 32 bytes from the secret. We use SHA-256 to keep things simple.
    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", textEncoder.encode(secret)),
      catch: (cause) => CryptoError.make({ operation: "digest", cause }),
    });

    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
          "encrypt",
          "decrypt",
        ] as KeyUsage[]),
      catch: (cause) => CryptoError.make({ operation: "importKey", cause }),
    });
  });

export const encrypt = (plaintext: string, secret: string): Effect.Effect<string, CryptoError> =>
  Effect.gen(function* () {
    const key = yield* deriveKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = textEncoder.encode(plaintext);

    const ciphertext = yield* Effect.tryPromise({
      try: () => crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded),
      catch: (cause) => CryptoError.make({ operation: "encrypt", cause }),
    });

    const cipherBytes = new Uint8Array(ciphertext);

    const out = new Uint8Array(iv.length + cipherBytes.length);
    out.set(iv, 0);
    out.set(cipherBytes, iv.length);

    return base64Encode(out);
  });

export const decrypt = (
  encrypted: string,
  secret: string,
): Effect.Effect<string, DecryptionError | CryptoError> =>
  Effect.gen(function* () {
    const key = yield* deriveKey(secret);
    const bytes = yield* base64DecodeToBytes(encrypted);

    // AES-GCM: 12 bytes IV + 16 bytes auth tag = 28 bytes minimum (empty plaintext)
    if (bytes.length < 28) {
      return yield* DecryptionError.make({ reason: "Invalid encrypted payload" });
    }

    const iv = bytes.slice(0, 12);
    const cipherBytes = bytes.slice(12);

    const plaintext = yield* Effect.tryPromise({
      try: () => crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes),
      catch: (cause) =>
        DecryptionError.make({
          reason: "Decryption failed",
          cause,
        }),
    });

    return textDecoder.decode(plaintext);
  });
