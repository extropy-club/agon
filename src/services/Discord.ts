import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";

export class MissingDiscordConfig extends Schema.TaggedError<MissingDiscordConfig>()(
  "MissingDiscordConfig",
  {
    key: Schema.String,
  },
) {}

export class DiscordApiError extends Schema.TaggedError<DiscordApiError>()("DiscordApiError", {
  endpoint: Schema.String,
  status: Schema.Number,
  body: Schema.String,
}) {}

export type DiscordError = MissingDiscordConfig | DiscordApiError;

export type DiscordWebhook = {
  readonly id: string;
  readonly token: string;
};

export type DiscordMessage = {
  readonly id: string;
  readonly content: string;
  readonly author: { readonly id: string; readonly username: string; readonly bot?: boolean };
};

const DISCORD_API = "https://discord.com/api/v10";

const requireRedacted = (key: string) =>
  Config.redacted(key).pipe(Effect.mapError(() => MissingDiscordConfig.make({ key })));

const requestJson = <A>(endpoint: string, init: RequestInit): Effect.Effect<A, DiscordApiError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${DISCORD_API}${endpoint}`, init);
      const body = await res.text();
      if (!res.ok) {
        throw { status: res.status, body };
      }
      return body.length === 0 ? (undefined as A) : (JSON.parse(body) as A);
    },
    catch: (e) => {
      const rec = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : undefined;
      const status = rec && "status" in rec ? Number(rec.status) : 0;
      const body = rec && "body" in rec ? String(rec.body) : String(e);
      return DiscordApiError.make({ endpoint, status, body });
    },
  });

export class Discord extends Context.Tag("@agon/Discord")<
  Discord,
  {
    readonly createWebhook: (channelId: string) => Effect.Effect<DiscordWebhook, DiscordError>;
    readonly fetchRecentMessages: (
      channelId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<DiscordMessage>, DiscordError>;
  }
>() {
  static readonly layer = Layer.effect(
    Discord,
    Effect.gen(function* () {
      const botToken = yield* requireRedacted("DISCORD_BOT_TOKEN");
      const authHeader = () => `Bot ${Redacted.value(botToken as Redacted.Redacted)}`;

      const createWebhook = (channelId: string) =>
        requestJson<{ id: string; token: string }>(`/channels/${channelId}/webhooks`, {
          method: "POST",
          headers: {
            Authorization: authHeader(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Agon Arena" }),
        }).pipe(Effect.mapError((e) => e as DiscordError));

      const fetchRecentMessages = (channelId: string, limit: number) =>
        requestJson<DiscordMessage[]>(`/channels/${channelId}/messages?limit=${limit}`, {
          method: "GET",
          headers: { Authorization: authHeader() },
        }).pipe(Effect.mapError((e) => e as DiscordError));

      return Discord.of({ createWebhook, fetchRecentMessages });
    }),
  );
}

/**
 * Discord interaction signature verification (Ed25519)
 *
 * Returns `false` on any failure.
 */
export const verifyDiscordInteraction = (args: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: Uint8Array;
}): Effect.Effect<boolean, never> =>
  Effect.tryPromise({
    try: async () => {
      const hexToBytes = (hex: string) => {
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++)
          out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return out;
      };

      const keyBytes = hexToBytes(args.publicKeyHex);
      const sigBytes = hexToBytes(args.signatureHex);
      const tsBytes = new TextEncoder().encode(args.timestamp);
      const msg = new Uint8Array(tsBytes.length + args.body.length);
      msg.set(tsBytes, 0);
      msg.set(args.body, tsBytes.length);

      const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, [
        "verify",
      ]);
      return crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, msg);
    },
    catch: () => new Error("verify failed"),
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
