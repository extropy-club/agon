import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

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

  /** Present when the message was created by a webhook. */
  readonly webhook_id?: string;

  /** ISO timestamp (as returned by the Discord API). */
  readonly timestamp: string;

  /** ISO timestamp or null when the message was never edited. */
  readonly edited_timestamp?: string | null;

  readonly author: { readonly id: string; readonly username: string; readonly bot?: boolean };
};

export type DiscordAutoArchiveDurationMinutes = 60 | 1440 | 4320 | 10080;

const DISCORD_API = "https://discord.com/api/v10";

const requireBotToken = (botToken: Option.Option<Redacted.Redacted>) =>
  Option.match(botToken, {
    onNone: () => Effect.fail(MissingDiscordConfig.make({ key: "DISCORD_BOT_TOKEN" })),
    onSome: (token) => Effect.succeed(token),
  });

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

type DiscordWebhookListItem = {
  readonly id: string;
  readonly name?: string;
  readonly token?: string | null;
};

type DiscordThread = { readonly id: string };

export class Discord extends Context.Tag("@agon/Discord")<
  Discord,
  {
    /**
     * Create a brand new webhook for a channel.
     */
    readonly createWebhook: (channelId: string) => Effect.Effect<DiscordWebhook, DiscordError>;

    /**
     * Reuse a webhook named "Agon Arena" if it exists, otherwise create one.
     */
    readonly createOrFetchWebhook: (
      parentChannelId: string,
    ) => Effect.Effect<DiscordWebhook, DiscordError>;

    /**
     * Create a public thread under a parent text channel.
     */
    readonly createPublicThread: (
      parentChannelId: string,
      args: { name: string; autoArchiveDurationMinutes: DiscordAutoArchiveDurationMinutes },
    ) => Effect.Effect<string, DiscordError>;

    readonly fetchRecentMessages: (
      channelId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<DiscordMessage>, DiscordError>;
  }
>() {
  static readonly layer = Layer.effect(
    Discord,
    Effect.gen(function* () {
      const botToken = yield* Config.option(Config.redacted("DISCORD_BOT_TOKEN"));

      const authHeader = (token: Redacted.Redacted) => `Bot ${Redacted.value(token)}`;

      const createWebhook = (channelId: string) =>
        requireBotToken(botToken).pipe(
          Effect.map(authHeader),
          Effect.flatMap((Authorization) =>
            requestJson<{ id: string; token: string }>(`/channels/${channelId}/webhooks`, {
              method: "POST",
              headers: {
                Authorization,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ name: "Agon Arena" }),
            }),
          ),
          Effect.mapError((e) => e as DiscordError),
        );

      const listWebhooks = (channelId: string) =>
        requireBotToken(botToken).pipe(
          Effect.map(authHeader),
          Effect.flatMap((Authorization) =>
            requestJson<ReadonlyArray<DiscordWebhookListItem>>(`/channels/${channelId}/webhooks`, {
              method: "GET",
              headers: { Authorization },
            }),
          ),
          Effect.mapError((e) => e as DiscordError),
        );

      const createOrFetchWebhook = (parentChannelId: string) =>
        listWebhooks(parentChannelId).pipe(
          Effect.flatMap((hooks) => {
            const existing = hooks.find((h) => h.name === "Agon Arena" && !!h.token);
            if (existing?.token) {
              return Effect.succeed({ id: existing.id, token: existing.token });
            }
            return createWebhook(parentChannelId);
          }),
        );

      const createPublicThread = (
        parentChannelId: string,
        args: { name: string; autoArchiveDurationMinutes: DiscordAutoArchiveDurationMinutes },
      ) =>
        requireBotToken(botToken).pipe(
          Effect.map(authHeader),
          Effect.flatMap((Authorization) =>
            requestJson<DiscordThread>(`/channels/${parentChannelId}/threads`, {
              method: "POST",
              headers: {
                Authorization,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                name: args.name,
                auto_archive_duration: args.autoArchiveDurationMinutes,
                // GUILD_PUBLIC_THREAD
                type: 11,
              }),
            }),
          ),
          Effect.map((t) => t.id),
          Effect.mapError((e) => e as DiscordError),
        );

      const fetchRecentMessages = (channelId: string, limit: number) =>
        requireBotToken(botToken).pipe(
          Effect.map(authHeader),
          Effect.flatMap((Authorization) =>
            requestJson<DiscordMessage[]>(`/channels/${channelId}/messages?limit=${limit}`, {
              method: "GET",
              headers: { Authorization },
            }),
          ),
          Effect.mapError((e) => e as DiscordError),
        );

      return Discord.of({
        createWebhook,
        createOrFetchWebhook,
        createPublicThread,
        fetchRecentMessages,
      });
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
