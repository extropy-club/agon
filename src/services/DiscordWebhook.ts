import { Context, Effect, Layer, Schema } from "effect";

export class DiscordWebhookPostFailed extends Schema.TaggedError<DiscordWebhookPostFailed>()(
  "DiscordWebhookPostFailed",
  {
    status: Schema.Int.pipe(Schema.nonNegative(), Schema.finite(), Schema.nonNaN()),
    body: Schema.String,
  },
) {}

export type DiscordWebhook = { readonly id: string; readonly token: string };

const isDiscordWebhookPostFailed = (u: unknown): u is DiscordWebhookPostFailed =>
  typeof u === "object" &&
  u !== null &&
  "_tag" in u &&
  (u as { _tag: string })._tag === "DiscordWebhookPostFailed";

export class DiscordWebhookPoster extends Context.Tag("@agon/DiscordWebhookPoster")<
  DiscordWebhookPoster,
  {
    readonly post: (args: {
      webhook: DiscordWebhook;
      threadId?: string;
      content: string;
      username: string;
      avatarUrl?: string;
    }) => Effect.Effect<void, DiscordWebhookPostFailed>;
  }
>() {
  static readonly layer = Layer.succeed(
    DiscordWebhookPoster,
    DiscordWebhookPoster.of({
      post: (args) =>
        Effect.tryPromise({
          try: async () => {
            const baseUrl = `https://discord.com/api/v10/webhooks/${args.webhook.id}/${args.webhook.token}`;
            const url = args.threadId
              ? `${baseUrl}?thread_id=${encodeURIComponent(args.threadId)}`
              : baseUrl;
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: args.content,
                username: args.username,
                ...(args.avatarUrl ? { avatar_url: args.avatarUrl } : {}),
                allowed_mentions: { parse: [] },
              }),
            });
            if (!res.ok) {
              const body = await res.text();
              return Promise.reject(DiscordWebhookPostFailed.make({ status: res.status, body }));
            }
          },
          catch: (e) =>
            isDiscordWebhookPostFailed(e)
              ? e
              : DiscordWebhookPostFailed.make({ status: 0, body: String(e) }),
        }),
    }),
  );
}
