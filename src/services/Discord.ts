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
  status: Schema.Number,
  body: Schema.String,
}) {}

export class DiscordRateLimited extends Schema.TaggedError<DiscordRateLimited>()(
  "DiscordRateLimited",
  {
    retryAfterMs: Schema.Number,
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

  readonly author: { readonly id: string; readonly username: string; readonly bot?: boolean };
};

export type DiscordAutoArchiveDurationMinutes = 60 | 1440 | 4320 | 10080;

const DISCORD_API = "https://discord.com/api/v10";

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

const parseRetryAfterMsFromBody = (body: string): number | null => {
  if (body.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    const ra = rec["retry_after"];
    if (typeof ra !== "number" || !Number.isFinite(ra)) return null;

    // Discord documents retry_after in seconds.
    return Math.max(0, Math.ceil(ra * 1000));
  } catch {
    return null;
  }
};

type DiscordRequestResult<A> =
  | {
      readonly _tag: "Ok";
      readonly value: A;
      readonly remaining: number | null;
      readonly resetAfterMs: number | null;
    }
  | { readonly _tag: "RateLimited"; readonly retryAfterMs: number }
  | { readonly _tag: "Error"; readonly status: number; readonly body: string };

const requestJson = <A>(
  endpoint: string,
  init: RequestInit,
): Effect.Effect<A, DiscordApiError | DiscordRateLimited> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${DISCORD_API}${endpoint}`, init);
      const body = await res.text();

      const remaining = parseRateLimitRemaining(res.headers.get("X-RateLimit-Remaining"));
      const resetAfterMs = parseSecondsHeaderMs(res.headers.get("X-RateLimit-Reset-After"));

      const retryAfterMs =
        parseSecondsHeaderMs(res.headers.get("Retry-After")) ??
        parseRetryAfterMsFromBody(body) ??
        resetAfterMs ??
        1000;

      if (res.status === 429) {
        return { _tag: "RateLimited", retryAfterMs } as const;
      }

      if (!res.ok) {
        return { _tag: "Error", status: res.status, body } as const;
      }

      if (body.length === 0) {
        return { _tag: "Ok", value: undefined as A, remaining, resetAfterMs } as const;
      }

      try {
        const parsed = JSON.parse(body) as A;
        return { _tag: "Ok", value: parsed, remaining, resetAfterMs } as const;
      } catch {
        return { _tag: "Error", status: res.status, body } as const;
      }
    },
    catch: (e) => {
      const rec = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : undefined;
      const status = rec && "status" in rec ? Number(rec.status) : 0;
      const body = rec && "body" in rec ? String(rec.body) : String(e);
      return DiscordApiError.make({ endpoint, status, body });
    },
  }).pipe(
    // Widen error type so downstream combinators can emit rate limit errors.
    Effect.mapError((e): DiscordApiError | DiscordRateLimited => e),
    Effect.flatMap(
      (result: DiscordRequestResult<A>): Effect.Effect<A, DiscordApiError | DiscordRateLimited> => {
        switch (result._tag) {
          case "RateLimited":
            return Effect.fail<DiscordApiError | DiscordRateLimited>(
              DiscordRateLimited.make({ retryAfterMs: result.retryAfterMs }),
            );

          case "Error":
            return Effect.fail<DiscordApiError | DiscordRateLimited>(
              DiscordApiError.make({ endpoint, status: result.status, body: result.body }),
            );

          case "Ok": {
            if (result.remaining === 0 && result.resetAfterMs !== null && result.resetAfterMs > 0) {
              const waitMs = result.resetAfterMs ?? 0;
              return Effect.gen(function* () {
                yield* Effect.logWarning("discord.rate_limit.bucket_exhausted").pipe(
                  Effect.annotateLogs({ endpoint, retryAfterMs: waitMs }),
                );
                yield* Effect.sleep(Duration.millis(waitMs));
                return result.value;
              });
            }

            return Effect.succeed(result.value);
          }
        }
      },
    ),
    Effect.tapError((e) => {
      if (e._tag === "DiscordRateLimited") {
        return Effect.logWarning("discord.rate_limited").pipe(
          Effect.annotateLogs({ endpoint, retryAfterMs: e.retryAfterMs }),
        );
      }
      return Effect.succeed(void 0);
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
            Effect.tryPromise({
              try: async () => {
                const endpoint = "/users/@me/guilds";
                const res = await fetch(`${DISCORD_API}${endpoint}`, {
                  method: "GET",
                  headers: { Authorization },
                });

                const body = await res.text();

                if (!res.ok) {
                  throw { status: res.status, body };
                }

                if (body.trim().length === 0) return [];

                const parsed: unknown = JSON.parse(body);
                if (!Array.isArray(parsed)) return [];

                return parsed
                  .map((g): DiscordGuild | null => {
                    if (typeof g !== "object" || g === null) return null;
                    const rec = g as Record<string, unknown>;

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
              },
              catch: (e) => {
                const rec =
                  typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
                const status = "status" in rec ? Number(rec.status) : 0;
                const body = "body" in rec ? String(rec.body) : String(e);
                return DiscordApiError.make({
                  endpoint: "/users/@me/guilds",
                  status: Number.isFinite(status) ? status : 0,
                  body,
                });
              },
            }),
          ),
        );

      return Discord.of({
        createWebhook,
        createOrFetchWebhook,
        createPublicThread,
        fetchChannelName,
        lockThread,
        unlockThread,
        postMessage,
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
    catch: () => new Error("verify failed"),
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
