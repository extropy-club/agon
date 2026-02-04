import { eq } from "drizzle-orm";
import * as ConfigProvider from "effect/ConfigProvider";
import { Effect, Layer } from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Db } from "./d1/db.js";
import { discordChannels } from "./d1/schema.js";
import { ArenaService, type RoomTurnJob } from "./services/ArenaService.js";
import {
  Discord,
  type DiscordAutoArchiveDurationMinutes,
  verifyDiscordInteraction,
} from "./services/Discord.js";
import { DiscordWebhookPoster } from "./services/DiscordWebhook.js";
import { LlmRouterLive } from "./services/LlmRouter.js";

export interface Env {
  DB: D1Database;
  ARENA_QUEUE: Queue<RoomTurnJob>;

  // Optional runtime config (usually provided via .dev.vars / wrangler secrets)
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;

  // LLM providers
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_AI_API_KEY?: string;

  ARENA_MAX_TURNS?: string;
  ARENA_HISTORY_LIMIT?: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const text = (status: number, body: string) => new Response(body, { status });

const makeConfigLayer = (env: Env) => {
  const map = new Map<string, string>();

  // Wrangler env vars
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") map.set(k, v);
  }

  return Layer.setConfigProvider(ConfigProvider.fromMap(map));
};

const makeRuntime = (env: Env) => {
  const dbLayer = Db.layer(env.DB);

  const infraLayer = Layer.mergeAll(
    dbLayer,
    DiscordWebhookPoster.layer,
    LlmRouterLive,
    Discord.layer,
  );

  const arenaLayer = ArenaService.layer.pipe(Layer.provide(infraLayer));

  const appLayer = Layer.mergeAll(infraLayer, arenaLayer).pipe(
    Layer.provideMerge(makeConfigLayer(env)),
  );

  return ManagedRuntime.make(appLayer);
};

const parseJson = <A>(request: Request): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: () => request.json() as Promise<A>,
    catch: (e) => e,
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const runtime = makeRuntime(env);

    // Health
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true });
    }

    // Discord interactions (PONG only for now; commands later)
    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const publicKey = env.DISCORD_PUBLIC_KEY;
      if (!publicKey) return json(500, { error: "Missing DISCORD_PUBLIC_KEY" });

      const sig = request.headers.get("X-Signature-Ed25519") ?? "";
      const ts = request.headers.get("X-Signature-Timestamp") ?? "";
      const raw = new Uint8Array(await request.clone().arrayBuffer());

      const ok = await runtime.runPromise(
        verifyDiscordInteraction({
          publicKeyHex: publicKey,
          signatureHex: sig,
          timestamp: ts,
          body: raw,
        }),
      );

      if (!ok) return json(401, { error: "Invalid signature" });

      const body = (await request.json()) as { type: number };
      if (body.type === 1) {
        return json(200, { type: 1 });
      }

      // TODO: implement /arena commands
      return json(200, {
        type: 4,
        data: { content: "Agon: interaction received (not implemented yet)." },
      });
    }

    // DEV: start arena without Discord
    if (url.pathname === "/dev/arena/start" && request.method === "POST") {
      const program = Effect.gen(function* () {
        const arena = yield* ArenaService;
        const payload = yield* parseJson<{ channelId: string; topic: string; agentIds?: string[] }>(
          request,
        ).pipe(Effect.orDie);
        const result = yield* arena.startArena(payload);
        return result;
      });

      const result = await runtime.runPromise(program);
      ctx.waitUntil(env.ARENA_QUEUE.send(result.firstJob));
      return json(200, {
        roomId: result.roomId,
        // Back-compat field name (temporary)
        arenaId: result.roomId,
        enqueued: true,
        firstJob: result.firstJob,
      });
    }

    // DEV: create a Discord room as a public thread under a parent channel
    if (url.pathname === "/dev/room/create" && request.method === "POST") {
      const payload = (await request.json().catch(() => null)) as unknown;
      const rec =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;

      const parentChannelId =
        rec && typeof rec.parentChannelId === "string" ? rec.parentChannelId : undefined;
      const name = rec && typeof rec.name === "string" ? rec.name : undefined;
      const topic = rec && typeof rec.topic === "string" ? rec.topic : undefined;

      const agentIdsRaw = rec && Array.isArray(rec.agentIds) ? rec.agentIds : undefined;
      const agentIds = agentIdsRaw?.filter((a): a is string => typeof a === "string");

      const allowed = [60, 1440, 4320, 10080] as const;
      const autoArchiveDurationMinutesRaw =
        rec && typeof rec.autoArchiveDurationMinutes === "number"
          ? rec.autoArchiveDurationMinutes
          : undefined;
      const autoArchiveDurationMinutesNum = autoArchiveDurationMinutesRaw ?? 1440;

      if (!parentChannelId || !name || !topic) {
        return json(400, { error: "Invalid payload" });
      }

      if (!allowed.includes(autoArchiveDurationMinutesNum as (typeof allowed)[number])) {
        return json(400, {
          error: "Invalid autoArchiveDurationMinutes",
          allowed,
        });
      }

      const autoArchiveDurationMinutes =
        autoArchiveDurationMinutesNum as DiscordAutoArchiveDurationMinutes;

      const program = Effect.gen(function* () {
        const discord = yield* Discord;
        const { db } = yield* Db;
        const arena = yield* ArenaService;

        const existingWebhook = yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(discordChannels)
              .where(eq(discordChannels.channelId, parentChannelId))
              .get(),
          catch: (e) => e,
        }).pipe(Effect.orDie);

        const webhook = existingWebhook
          ? { id: existingWebhook.webhookId, token: existingWebhook.webhookToken }
          : yield* discord.createOrFetchWebhook(parentChannelId);

        // Upsert webhook mapping for the parent channel
        yield* Effect.tryPromise({
          try: () =>
            db
              .insert(discordChannels)
              .values({
                channelId: parentChannelId,
                webhookId: webhook.id,
                webhookToken: webhook.token,
              })
              .onConflictDoUpdate({
                target: discordChannels.channelId,
                set: { webhookId: webhook.id, webhookToken: webhook.token },
              })
              .run(),
          catch: (e) => e,
        }).pipe(Effect.orDie);

        const threadId = yield* discord.createPublicThread(parentChannelId, {
          name,
          autoArchiveDurationMinutes,
        });

        const result = yield* arena.createRoom({
          parentChannelId,
          threadId,
          topic,
          autoArchiveDurationMinutes,
          ...(agentIds && agentIds.length > 0 ? { agentIds } : {}),
        });

        return { roomId: result.roomId, threadId, firstJob: result.firstJob } as const;
      });

      const result = await runtime.runPromise(program);
      ctx.waitUntil(env.ARENA_QUEUE.send(result.firstJob));
      return json(200, { roomId: result.roomId, threadId: result.threadId });
    }

    if (url.pathname === "/dev/arena/stop" && request.method === "POST") {
      const program = Effect.gen(function* () {
        const arena = yield* ArenaService;
        const payload = yield* parseJson<{ roomId?: number; arenaId?: number }>(request).pipe(
          Effect.orDie,
        );
        const roomId = payload.roomId ?? payload.arenaId;
        if (roomId === undefined) {
          return yield* Effect.dieMessage("Missing roomId");
        }
        yield* arena.stopArena(roomId);
        return { ok: true };
      });

      return json(200, await runtime.runPromise(program));
    }

    return text(404, "Not Found");
  },

  async queue(batch: MessageBatch<RoomTurnJob>, env: Env, ctx: ExecutionContext): Promise<void> {
    const runtime = makeRuntime(env);

    for (const message of batch.messages) {
      const job = message.body as RoomTurnJob;

      const program = Effect.gen(function* () {
        const arena = yield* ArenaService;
        return yield* arena.processTurn(job);
      });

      const next = await runtime.runPromise(program);
      if (next) {
        ctx.waitUntil(env.ARENA_QUEUE.send(next));
      }

      message.ack();
    }
  },
};
