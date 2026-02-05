import { Config, Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { Settings } from "./Settings.js";

export class MissingDiscordConfig extends Schema.TaggedError<MissingDiscordConfig>()(
  "MissingDiscordConfig",
  {
    key: Schema.String,
  },
) {}

export class DiscordApiError extends Schema.TaggedError<DiscordApiError>()("DiscordApiError", {
  endpoint: Schema.String,
  status: Schema.Int.pipe(Schema.nonNegative(), Schema.finite(), Schema.nonNaN()),
  body: Schema.String,
}) {}

export class DiscordRateLimited extends Schema.TaggedError<DiscordRateLimited>()(
  "DiscordRateLimited",
  {
    retryAfterMs: Schema.Int.pipe(Schema.nonNegative(), Schema.finite(), Schema.nonNaN()),
  },
) {}

export class DiscordVerifyError extends Schema.TaggedError<DiscordVerifyError>()(
  "DiscordVerifyError",
  {
    message: Schema.String,
  },
) {}

export type DiscordError = MissingDiscordConfig | DiscordApiError | DiscordRateLimited;

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

  readonly author: {
    readonly id: string;
    readonly username: string;
    readonly global_name?: string | null;
    readonly bot?: boolean;
  };
};

export type DiscordAutoArchiveDurationMinutes = 60 | 1440 | 4320 | 10080;

const DISCORD_API = "https://discord.com/api/v10";

export const DiscordResponseSchema = Schema.Union(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  Schema.Array(Schema.Unknown),
);
export type DiscordResponse = typeof DiscordResponseSchema.Type;

const DiscordRateLimitedBodySchema = Schema.Struct({
  retry_after: Schema.Number.pipe(Schema.nonNegative(), Schema.finite(), Schema.nonNaN()),
});

const DiscordUnknownObjectSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
}).pipe(
  Schema.filter((u): u is Record<string, unknown> => !Array.isArray(u), {
    message: () => "Expected object",
  }),
);

const requireBotToken = (
  botToken: Option.Option<Redacted.Redacted>,
): Effect.Effect<Redacted.Redacted, MissingDiscordConfig> =>
  Option.match(botToken, {
    onNone: () => Effect.fail(MissingDiscordConfig.make({ key: "DISCORD_BOT_TOKEN" })),
    onSome: (token) => Effect.succeed(token),
  });

const parseSecondsHeaderMs = (raw: string | null): number | null => {
  if (raw === null) return null;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.ceil(n * 1000));
};

const parseRateLimitRemaining = (raw: string | null): number | null => {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
};

const parseRetryAfterMsFromBody = (body: string): Effect.Effect<number | null, never> =>
  Effect.gen(function* () {
    if (body.trim().length === 0) return null;

    const parsed = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: () => "Invalid JSON",
    }).pipe(Effect.catchAll(() => Effect.succeed<unknown | null>(null)));

    if (parsed === null) return null;

    const decoded = yield* Schema.decodeUnknown(DiscordRateLimitedBodySchema)(parsed).pipe(
      Effect.catchAll(() => Effect.succeed<typeof DiscordRateLimitedBodySchema.Type | null>(null)),
    );

    if (decoded === null) return null;

    // Discord documents retry_after in seconds.
    return Math.max(0, Math.ceil(decoded.retry_after * 1000));
  });

const requestJson = <A extends DiscordResponse>(
  endpoint: string,
  init: RequestInit,
): Effect.Effect<A, DiscordApiError | DiscordRateLimited> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(`${DISCORD_API}${endpoint}`, init),
      catch: (e) => {
        const rec =
          typeof e === "object" && e !== null ? (e as Record<string, unknown>) : undefined;
        const status = rec && "status" in rec ? Number(rec.status) : 0;
        const body = rec && "body" in rec ? String(rec.body) : String(e);
        return DiscordApiError.make({ endpoint, status, body });
      },
    });

    const body = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (e) => DiscordApiError.make({ endpoint, status: res.status, body: String(e) }),
    });

    const remaining = parseRateLimitRemaining(res.headers.get("X-RateLimit-Remaining"));
    const resetAfterMs = parseSecondsHeaderMs(res.headers.get("X-RateLimit-Reset-After"));

    const retryAfterMsFromBody = yield* parseRetryAfterMsFromBody(body);

    const retryAfterMs =
      parseSecondsHeaderMs(res.headers.get("Retry-After")) ??
      retryAfterMsFromBody ??
      resetAfterMs ??
      1000;

    if (res.status === 429) {
      return yield* DiscordRateLimited.make({ retryAfterMs });
    }

    if (!res.ok) {
      return yield* DiscordApiError.make({ endpoint, status: res.status, body });
    }

    if (body.length === 0) {
      return yield* DiscordApiError.make({
        endpoint,
        status: res.status,
        body: "Empty response body",
      });
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: () => DiscordApiError.make({ endpoint, status: res.status, body }),
    });

    const value = (yield* Schema.decodeUnknown(DiscordResponseSchema)(parsed).pipe(
      Effect.mapError(() => DiscordApiError.make({ endpoint, status: res.status, body })),
    )) as A;

    if (remaining === 0 && resetAfterMs !== null && resetAfterMs > 0) {
      const waitMs = resetAfterMs ?? 0;
      yield* Effect.logWarning("discord.rate_limit.bucket_exhausted").pipe(
        Effect.annotateLogs({ endpoint, retryAfterMs: waitMs }),
      );
      yield* Effect.sleep(Duration.millis(waitMs));
    }

    return value;
  }).pipe(
    Effect.tapError((e) => {
      if (e._tag === "DiscordRateLimited") {
        return Effect.logWarning("discord.rate_limited").pipe(
          Effect.annotateLogs({ endpoint, retryAfterMs: e.retryAfterMs }),
        );
      }
      return Effect.void;
    }),
  );

type DiscordWebhookListItem = {
  readonly id: string;
  readonly name?: string;
  readonly token?: string | null;
};

type DiscordThread = { readonly id: string };

type DiscordChannel = { readonly id: string; readonly name?: string };

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

    /**
     * Fetch the name of a channel/thread.
     */
    readonly fetchChannelName: (channelId: string) => Effect.Effect<string, DiscordError>;

    /**
     * Post a message to a channel/thread as the bot.
     */
    readonly postMessage: (
      channelId: string,
      content: string,
    ) => Effect.Effect<DiscordMessage, DiscordError>;

    readonly fetchRecentMessages: (
      channelId: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<DiscordMessage>, DiscordError>;

    /**
     * Resolve the bot user's id (used to classify non-webhook bot messages as notifications).
     *
     * Prefers DISCORD_BOT_USER_ID config when provided, otherwise fetches /users/@me.
     */
    readonly getBotUserId: () => Effect.Effect<string, DiscordError>;

    readonly getGuilds: () => Effect.Effect<
      Array<{ id: string; name: string; icon: string | null; owner: boolean }>,
      DiscordApiError
    >;

    /**
     * Lock a thread to prevent non-bot users from sending messages.
     *
     * Requires the bot to have the MANAGE_THREADS permission in the parent channel.
     */
    readonly deleteMessage: (
      channelId: string,
      messageId: string,
    ) => Effect.Effect<void, DiscordError>;

    readonly lockThread: (threadId: string) => Effect.Effect<void, DiscordError>;

    /**
     * Unlock a previously locked thread.
     */
    readonly unlockThread: (threadId: string) => Effect.Effect<void, DiscordError>;
  }
>() {
  static readonly layer = Layer.effect(
    Discord,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const botToken = yield* settings.getSetting("DISCORD_BOT_TOKEN");
      const configuredBotUserId = yield* Config.option(Config.string("DISCORD_BOT_USER_ID"));

      // Cache within the worker isolate (module instance) to avoid repeated Discord API calls.
      let botUserIdCache: string | undefined;

      const sanitizeToken = (s: string) =>
        s
          .trim()
          .replace(/^"(.*)"$/, "$1")
          .replace(/^'(.*)'$/, "$1")
          .replace(/^Bot\s+/i, "")
          .replace(/^Bearer\s+/i, "");

      const authHeader = (token: Redacted.Redacted) =>
        `Bot ${sanitizeToken(Redacted.value(token))}`;

      const getBotUserId = () =>
        Effect.suspend(() => {
          if (botUserIdCache) return Effect.succeed(botUserIdCache);

          return Option.match(configuredBotUserId, {
            onSome: (id) =>
              Effect.sync(() => {
                botUserIdCache = id;
                return id;
              }),
            onNone: () =>
              requireBotToken(botToken).pipe(
                Effect.map(authHeader),
                Effect.flatMap((Authorization) =>
                  requestJson<{ id: string }>(`/users/@me`, {
                    method: "GET",
                    headers: { Authorization },
                  }),
                ),
                Effect.map((u) => u.id),
                Effect.tap((id) =>
                  Effect.sync(() => {
                    botUserIdCache = id;
                  }),
                ),
                Effect.mapError((e) => e as DiscordError),
              ),
          });
        });

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

      const fetchChannelName = (channelId: string) =>
        requireBotToken(botToken).pipe(
          Effect.map(authHeader),
          Effect.flatMap((Authorization) =>
            requestJson<DiscordChannel>(`/channels/${channelId}`, {
              method: "GET",
              headers: { Authorization },
            }),
          ),
          Effect.map((c) => c.name ?? ""),
          Effect.mapError((e) => e as DiscordError),
        );

      const setThreadLocked = (threadId: string, locked: boolean) =>
        requireBotToken(botToken).pipe(
          Effect.map(authHeader),
          Effect.flatMap((Authorization) =>
            requestJson<DiscordChannel>(`/channels/${threadId}`, {
              method: "PATCH",
              headers: {
                Authorization,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ locked }),
            }),
          ),
          Effect.asVoid,
          Effect.mapError((e) => e as DiscordError),
        );

      const lockThread = (threadId: string) => setThreadLocked(threadId, true);

      const unlockThread = (threadId: string) => setThreadLocked(threadId, false);

      const postMessage = (channelId: string, content: string) =>
        requireBotToken(botToken).pipe(
          Effect.map(authHeader),
          Effect.flatMap((Authorization) =>
            requestJson<DiscordMessage>(`/channels/${channelId}/messages`, {
              method: "POST",
              headers: {
                Authorization,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                content,
                allowed_mentions: { parse: [] },
              }),
            }),
          ),
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

      type DiscordGuild = { id: string; name: string; icon: string | null; owner: boolean };

      const getGuilds: () => Effect.Effect<Array<DiscordGuild>, DiscordApiError> = () =>
        requireBotToken(botToken).pipe(
          Effect.map(authHeader),
          Effect.mapError((e) =>
            DiscordApiError.make({
              endpoint: "/users/@me/guilds",
              status: 0,
              body: `Missing ${e.key}`,
            }),
          ),
          Effect.flatMap((Authorization) =>
            Effect.gen(function* () {
              const endpoint = "/users/@me/guilds";
              const res = yield* Effect.tryPromise({
                try: () =>
                  fetch(`${DISCORD_API}${endpoint}`, {
                    method: "GET",
                    headers: { Authorization },
                  }),
                catch: (cause) =>
                  DiscordApiError.make({
                    endpoint,
                    status: 0,
                    body: String(cause),
                  }),
              });

              const body = yield* Effect.tryPromise({
                try: () => res.text(),
                catch: (cause) =>
                  DiscordApiError.make({
                    endpoint,
                    status: res.status,
                    body: String(cause),
                  }),
              });

              if (!res.ok) {
                return yield* DiscordApiError.make({ endpoint, status: res.status, body });
              }

              if (body.trim().length === 0) return [];

              const parsed = yield* Effect.try({
                try: () => JSON.parse(body) as unknown,
                catch: () => DiscordApiError.make({ endpoint, status: res.status, body }),
              });

              const decoded = yield* Schema.decodeUnknown(Schema.Array(DiscordUnknownObjectSchema))(
                parsed,
              ).pipe(
                Effect.catchAll(() => Effect.succeed<ReadonlyArray<Record<string, unknown>>>([])),
              );

              return decoded
                .map((rec): DiscordGuild | null => {
                  const id = typeof rec.id === "string" ? rec.id : "";
                  const name = typeof rec.name === "string" ? rec.name : "";
                  const iconRaw = rec.icon;
                  const icon =
                    iconRaw === null ? null : typeof iconRaw === "string" ? iconRaw : null;
                  const owner = rec.owner === true;

                  if (!id || !name) return null;
                  return { id, name, icon, owner };
                })
                .filter((x): x is DiscordGuild => x !== null);
            }),
          ),
        );

      const deleteMessage = (channelId: string, messageId: string) => {
        const endpoint = `/channels/${channelId}/messages/${messageId}`;
        return requireBotToken(botToken).pipe(
          Effect.map(authHeader),
          Effect.flatMap((Authorization) =>
            Effect.gen(function* () {
              const res = yield* Effect.tryPromise({
                try: () =>
                  fetch(`${DISCORD_API}${endpoint}`, {
                    method: "DELETE",
                    headers: { Authorization },
                  }),
                catch: (e) => DiscordApiError.make({ endpoint, status: 0, body: String(e) }),
              });

              // 204 No Content = success, 404 = already deleted — both fine.
              if (res.status === 204 || res.status === 404) return;

              const body = yield* Effect.tryPromise({
                try: () => res.text(),
                catch: (e) =>
                  DiscordApiError.make({ endpoint, status: res.status, body: String(e) }),
              });

              if (res.status === 429) {
                const retryAfterMs = parseSecondsHeaderMs(res.headers.get("Retry-After")) ?? 1000;
                return yield* DiscordRateLimited.make({ retryAfterMs });
              }

              if (!res.ok) {
                return yield* DiscordApiError.make({ endpoint, status: res.status, body });
              }
            }),
          ),
          Effect.mapError((e) => e as DiscordError),
        );
      };

      return Discord.of({
        createWebhook,
        createOrFetchWebhook,
        createPublicThread,
        fetchChannelName,
        lockThread,
        unlockThread,
        postMessage,
        deleteMessage,
        fetchRecentMessages,
        getBotUserId,
        getGuilds,
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
    catch: (e) => {
      const rec = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
      const message = "message" in rec ? String(rec.message) : "verify failed";
      return DiscordVerifyError.make({ message });
    },
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
