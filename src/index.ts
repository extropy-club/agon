import { asc, desc, eq, sql } from "drizzle-orm";
import * as ConfigProvider from "effect/ConfigProvider";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Db } from "./d1/db.js";
import { agents, discordChannels, messages, roomAgents, rooms } from "./d1/schema.js";
import { ArenaService, type RoomTurnJob } from "./services/ArenaService.js";
import {
  Discord,
  type DiscordAutoArchiveDurationMinutes,
  verifyDiscordInteraction,
} from "./services/Discord.js";
import { DiscordWebhookPoster } from "./services/DiscordWebhook.js";
import { LlmRouterLive } from "./services/LlmRouter.js";
import { Observability } from "./services/Observability.js";

export interface Env {
  DB: D1Database;
  ARENA_QUEUE: Queue<RoomTurnJob>;

  // Optional runtime config (usually provided via .dev.vars / wrangler secrets)
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;

  // Optional Cloudflare dashboard deep links (used by admin UI)
  CF_ACCOUNT_ID?: string;
  CF_WORKER_SERVICE?: string;
  CF_QUEUE_NAME?: string;
  CF_D1_NAME?: string;

  // LLM providers
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_AI_API_KEY?: string;

  ARENA_MAX_TURNS?: string;
  ARENA_HISTORY_LIMIT?: string;

  // Admin API auth
  ADMIN_TOKEN?: string;
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

  // IMPORTANT: secrets can be defined as non-enumerable properties on `env`,
  // so `Object.entries(env)` may miss them. We explicitly copy the ones we use.
  const secretKeys = [
    "ADMIN_TOKEN",
    "DISCORD_PUBLIC_KEY",
    "DISCORD_BOT_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_AI_API_KEY",
    "LOG_LEVEL",
    "LOG_FORMAT",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "ARENA_MAX_TURNS",
    "ARENA_HISTORY_LIMIT",
    "CF_ACCOUNT_ID",
    "CF_WORKER_SERVICE",
    "CF_QUEUE_NAME",
    "CF_D1_NAME",
  ] as const;

  for (const k of secretKeys) {
    const v = (env as unknown as Record<string, unknown>)[k];
    if (typeof v === "string") map.set(k, v);
  }

  return Layer.setConfigProvider(ConfigProvider.fromMap(map));
};

const makeRuntime = (env: Env) => {
  const dbLayer = Db.layer(env.DB);

  const infraLayer = Layer.mergeAll(
    dbLayer,
    Observability.layer,
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

export class AdminUnauthorized extends Schema.TaggedError<AdminUnauthorized>()(
  "AdminUnauthorized",
  {},
) {}

export class AdminMissingConfig extends Schema.TaggedError<AdminMissingConfig>()(
  "AdminMissingConfig",
  {
    key: Schema.String,
  },
) {}

export class AdminBadRequest extends Schema.TaggedError<AdminBadRequest>()("AdminBadRequest", {
  message: Schema.String,
}) {}

export class AdminNotFound extends Schema.TaggedError<AdminNotFound>()("AdminNotFound", {
  resource: Schema.String,
  id: Schema.String,
}) {}

export class AdminDbError extends Schema.TaggedError<AdminDbError>()("AdminDbError", {
  cause: Schema.Defect,
}) {}

export class AdminQueueError extends Schema.TaggedError<AdminQueueError>()("AdminQueueError", {
  cause: Schema.Defect,
}) {}

const requireAdmin = (request: Request) =>
  Effect.gen(function* () {
    const opt = yield* Config.option(Config.redacted("ADMIN_TOKEN")).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none())),
    );

    if (Option.isNone(opt)) {
      return yield* Effect.fail(AdminMissingConfig.make({ key: "ADMIN_TOKEN" }));
    }

    const auth = request.headers.get("authorization") ?? "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return yield* Effect.fail(AdminUnauthorized.make({}));

    if (Redacted.value(opt.value) !== match[1]) {
      return yield* Effect.fail(AdminUnauthorized.make({}));
    }
  });

const decodeBody = <A>(request: Request, schema: Schema.Schema<A>) =>
  parseJson<unknown>(request).pipe(
    Effect.flatMap((u) => Schema.decodeUnknown(schema)(u)),
    Effect.mapError(() => AdminBadRequest.make({ message: "Invalid JSON body" })),
  );

const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const dbTry = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => AdminDbError.make({ cause }),
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const runtime = makeRuntime(env);

    const requestId =
      request.headers.get("CF-Ray") ?? request.headers.get("cf-ray") ?? crypto.randomUUID();

    // Admin API
    if (url.pathname.startsWith("/admin")) {
      const segments = url.pathname.split("/").filter(Boolean);

      const AgentProviderSchema = Schema.Literal("openai", "anthropic", "gemini");

      const AgentCreateSchema = Schema.Struct({
        id: Schema.optional(Schema.String),
        name: Schema.String,
        avatarUrl: Schema.optional(Schema.String),
        systemPrompt: Schema.String,
        llmProvider: Schema.optional(AgentProviderSchema),
        llmModel: Schema.optional(Schema.String),
      });

      const AgentUpdateSchema = Schema.Struct({
        name: Schema.optional(Schema.String),
        avatarUrl: Schema.optional(Schema.String),
        systemPrompt: Schema.optional(Schema.String),
        llmProvider: Schema.optional(AgentProviderSchema),
        llmModel: Schema.optional(Schema.String),
      });

      const CreateRoomSchema = Schema.Struct({
        parentChannelId: Schema.String,
        topic: Schema.String,
        autoArchiveDurationMinutes: Schema.optional(Schema.Number),
        agentIds: Schema.Array(Schema.String),
        // Provide threadId to bind to an existing thread. If omitted, we will create a thread.
        threadId: Schema.optional(Schema.String),
        threadName: Schema.optional(Schema.String),
      });

      const program = Effect.gen(function* () {
        yield* requireAdmin(request);
        const { db } = yield* Db;

        // /admin/meta
        if (segments.length === 2 && segments[1] === "meta") {
          if (request.method !== "GET") {
            return json(405, { error: "Method not allowed" });
          }

          const accountId = yield* Config.option(Config.string("CF_ACCOUNT_ID")).pipe(
            Effect.map(Option.getOrNull),
          );

          const workerService = yield* Config.option(Config.string("CF_WORKER_SERVICE")).pipe(
            Effect.map(Option.getOrElse(() => "agon")),
          );

          const queueName = yield* Config.option(Config.string("CF_QUEUE_NAME")).pipe(
            Effect.map(Option.getOrElse(() => "arena-turns")),
          );

          const d1Name = yield* Config.option(Config.string("CF_D1_NAME")).pipe(
            Effect.map(Option.getOrElse(() => "agon-db")),
          );

          if (!accountId) {
            return json(200, {
              configured: false,
              missing: ["CF_ACCOUNT_ID"],
            });
          }

          return json(200, {
            configured: true,
            cloudflare: {
              accountId,
              workerService,
              queueName,
              d1Name,
              links: {
                queueMetrics: `https://dash.cloudflare.com/${accountId}/workers/queues/view/${encodeURIComponent(queueName)}`,
                workerLogs: `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(workerService)}/production/observability/logs`,
                d1Console: `https://dash.cloudflare.com/${accountId}/workers/d1/view/${encodeURIComponent(d1Name)}`,
              },
            },
          });
        }

        // /admin/agents
        if (segments.length === 2 && segments[1] === "agents") {
          if (request.method === "GET") {
            const rows = yield* dbTry(() =>
              db.select().from(agents).orderBy(asc(agents.name)).all(),
            );
            return json(200, { agents: rows });
          }

          if (request.method === "POST") {
            const body = yield* decodeBody(request, AgentCreateSchema);
            const id = body.id ? body.id : slugify(body.name);
            if (!id) return json(400, { error: "Invalid id" });

            const avatarUrl = body.avatarUrl?.trim();
            const avatarUrlOrNull = avatarUrl && avatarUrl.length > 0 ? avatarUrl : null;

            yield* dbTry(() =>
              db
                .insert(agents)
                .values({
                  id,
                  name: body.name,
                  avatarUrl: avatarUrlOrNull,
                  systemPrompt: body.systemPrompt,
                  llmProvider: body.llmProvider ?? "openai",
                  llmModel: body.llmModel ?? "gpt-4o-mini",
                })
                .onConflictDoUpdate({
                  target: agents.id,
                  set: {
                    name: body.name,
                    avatarUrl: avatarUrlOrNull,
                    systemPrompt: body.systemPrompt,
                    llmProvider: body.llmProvider ?? "openai",
                    llmModel: body.llmModel ?? "gpt-4o-mini",
                  },
                })
                .run(),
            );

            const agent = yield* dbTry(() =>
              db.select().from(agents).where(eq(agents.id, id)).get(),
            );
            return json(200, { agent });
          }

          return json(405, { error: "Method not allowed" });
        }

        // /admin/agents/:id
        if (segments.length === 3 && segments[1] === "agents") {
          const agentId = segments[2];

          if (request.method === "GET") {
            const agent = yield* dbTry(() =>
              db.select().from(agents).where(eq(agents.id, agentId)).get(),
            );
            if (!agent) {
              return yield* Effect.fail(AdminNotFound.make({ resource: "agent", id: agentId }));
            }
            return json(200, { agent });
          }

          if (request.method === "PUT") {
            const body = yield* decodeBody(request, AgentUpdateSchema);

            const existing = yield* dbTry(() =>
              db.select().from(agents).where(eq(agents.id, agentId)).get(),
            );
            if (!existing) {
              return yield* Effect.fail(AdminNotFound.make({ resource: "agent", id: agentId }));
            }

            yield* dbTry(() =>
              db
                .update(agents)
                .set({
                  ...(body.name !== undefined ? { name: body.name } : {}),
                  ...(body.avatarUrl !== undefined
                    ? {
                        avatarUrl: body.avatarUrl.trim().length > 0 ? body.avatarUrl.trim() : null,
                      }
                    : {}),
                  ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}),
                  ...(body.llmProvider !== undefined ? { llmProvider: body.llmProvider } : {}),
                  ...(body.llmModel !== undefined ? { llmModel: body.llmModel } : {}),
                })
                .where(eq(agents.id, agentId))
                .run(),
            );

            const agent = yield* dbTry(() =>
              db.select().from(agents).where(eq(agents.id, agentId)).get(),
            );
            return json(200, { agent });
          }

          if (request.method === "DELETE") {
            yield* dbTry(() => db.delete(agents).where(eq(agents.id, agentId)).run());
            return json(200, { ok: true });
          }

          return json(405, { error: "Method not allowed" });
        }

        // /admin/rooms
        if (segments.length === 2 && segments[1] === "rooms") {
          if (request.method === "GET") {
            const rs = yield* dbTry(() => db.select().from(rooms).orderBy(desc(rooms.id)).all());
            return json(200, { rooms: rs });
          }

          if (request.method === "POST") {
            const body = yield* decodeBody(request, CreateRoomSchema);
            const arena = yield* ArenaService;
            const discord = yield* Discord;

            const allowed = [60, 1440, 4320, 10080] as const;
            const autoArchiveDurationMinutes = allowed.includes(
              body.autoArchiveDurationMinutes as (typeof allowed)[number],
            )
              ? (body.autoArchiveDurationMinutes as number)
              : 1440;

            // ensure webhook mapping for parent channel
            const existingWebhook = yield* dbTry(() =>
              db
                .select()
                .from(discordChannels)
                .where(eq(discordChannels.channelId, body.parentChannelId))
                .get(),
            );

            const webhook = existingWebhook
              ? { id: existingWebhook.webhookId, token: existingWebhook.webhookToken }
              : yield* discord.createOrFetchWebhook(body.parentChannelId);

            yield* dbTry(() =>
              db
                .insert(discordChannels)
                .values({
                  channelId: body.parentChannelId,
                  webhookId: webhook.id,
                  webhookToken: webhook.token,
                })
                .onConflictDoUpdate({
                  target: discordChannels.channelId,
                  set: { webhookId: webhook.id, webhookToken: webhook.token },
                })
                .run(),
            );

            const threadName = body.threadName?.trim();
            const threadId = body.threadId
              ? body.threadId
              : yield* discord.createPublicThread(body.parentChannelId, {
                  name:
                    threadName && threadName.length > 0
                      ? threadName
                      : `Agon Room ${new Date().toISOString()}`,
                  autoArchiveDurationMinutes:
                    autoArchiveDurationMinutes as DiscordAutoArchiveDurationMinutes,
                });

            const result = yield* arena.createRoom({
              parentChannelId: body.parentChannelId,
              threadId,
              topic: body.topic,
              autoArchiveDurationMinutes,
              agentIds: body.agentIds,
            });

            yield* Effect.tryPromise({
              try: () => env.ARENA_QUEUE.send(result.firstJob),
              catch: (cause) => AdminQueueError.make({ cause }),
            });

            const markerUpdated = yield* dbTry(() =>
              db
                .update(rooms)
                .set({
                  lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${result.firstJob.turnNumber})`,
                })
                .where(eq(rooms.id, result.roomId))
                .run(),
            ).pipe(
              Effect.as(true),
              Effect.catchAll((e) =>
                Effect.logError("admin.last_enqueued_turn.update_failed").pipe(
                  Effect.annotateLogs({ cause: String(e.cause) }),
                  Effect.as(false),
                ),
              ),
            );

            return json(200, {
              roomId: result.roomId,
              threadId,
              firstJob: result.firstJob,
              enqueued: true,
              markerUpdated,
            });
          }

          return json(405, { error: "Method not allowed" });
        }

        // /admin/rooms/:id
        if (segments.length === 3 && segments[1] === "rooms") {
          const roomId = Number(segments[2]);
          if (!Number.isFinite(roomId)) return json(400, { error: "Invalid room id" });

          if (request.method === "GET") {
            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            const participants = yield* dbTry(() =>
              db
                .select({
                  turnOrder: roomAgents.turnOrder,
                  agent: agents,
                })
                .from(roomAgents)
                .innerJoin(agents, eq(roomAgents.agentId, agents.id))
                .where(eq(roomAgents.roomId, roomId))
                .orderBy(asc(roomAgents.turnOrder))
                .all(),
            );

            const recentMessages = yield* dbTry(() =>
              db
                .select()
                .from(messages)
                .where(eq(messages.roomId, roomId))
                .orderBy(desc(messages.createdAtMs), desc(messages.id))
                .limit(50)
                .all(),
            );

            return json(200, { room, participants, recentMessages });
          }

          return json(405, { error: "Method not allowed" });
        }

        // /admin/rooms/:id/pause | /admin/rooms/:id/resume
        if (segments.length === 4 && segments[1] === "rooms") {
          const roomId = Number(segments[2]);
          if (!Number.isFinite(roomId)) return json(400, { error: "Invalid room id" });

          if (request.method !== "POST") return json(405, { error: "Method not allowed" });

          const action = segments[3];

          if (action === "pause") {
            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            yield* dbTry(() =>
              db.update(rooms).set({ status: "paused" }).where(eq(rooms.id, roomId)).run(),
            );
            return json(200, { ok: true });
          }

          if (action === "resume") {
            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            yield* dbTry(() =>
              db.update(rooms).set({ status: "active" }).where(eq(rooms.id, roomId)).run(),
            );

            const nextTurnNumber = room.currentTurnNumber + 1;

            if (room.lastEnqueuedTurnNumber < nextTurnNumber) {
              const job = { roomId, turnNumber: nextTurnNumber } as const;
              yield* Effect.tryPromise({
                try: () => env.ARENA_QUEUE.send(job),
                catch: (cause) => AdminQueueError.make({ cause }),
              });

              yield* dbTry(() =>
                db
                  .update(rooms)
                  .set({
                    lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${nextTurnNumber})`,
                  })
                  .where(eq(rooms.id, roomId))
                  .run(),
              ).pipe(
                Effect.catchAll((e) =>
                  Effect.logError("admin.last_enqueued_turn.update_failed").pipe(
                    Effect.annotateLogs({ cause: String(e.cause) }),
                    Effect.asVoid,
                  ),
                ),
              );
            }

            return json(200, { ok: true, enqueued: room.lastEnqueuedTurnNumber < nextTurnNumber });
          }

          return json(404, { error: "Not Found" });
        }

        return json(404, { error: "Not Found" });
      }).pipe(
        Effect.annotateLogs({ requestId, route: url.pathname }),
        Effect.withLogSpan("http.admin"),
        Effect.catchTag("AdminUnauthorized", () =>
          Effect.succeed(json(401, { error: "Unauthorized", requestId })),
        ),
        Effect.catchTag("AdminMissingConfig", (e) =>
          Effect.succeed(json(500, { error: `Missing ${e.key}`, requestId })),
        ),
        Effect.catchTag("AdminBadRequest", (e) =>
          Effect.succeed(json(400, { error: e.message, requestId })),
        ),
        Effect.catchTag("AdminNotFound", (e) =>
          Effect.succeed(json(404, { error: `${e.resource} not found`, id: e.id, requestId })),
        ),
        Effect.catchTag("AdminDbError", (e) =>
          Effect.gen(function* () {
            yield* Effect.logError("admin.db_error").pipe(
              Effect.annotateLogs({ cause: String(e.cause) }),
            );
            return json(500, { error: "DB error", requestId });
          }),
        ),
        Effect.catchTag("AdminQueueError", (e) =>
          Effect.gen(function* () {
            yield* Effect.logError("admin.queue_error").pipe(
              Effect.annotateLogs({ cause: String(e.cause) }),
            );
            return json(500, { error: "Queue error", requestId });
          }),
        ),
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("admin.unhandled").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            );
            return json(500, { error: "Internal error", requestId });
          }),
        ),
      );

      return await runtime.runPromise(program);
    }

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
        }).pipe(
          Effect.annotateLogs({ requestId, route: "/discord/interactions" }),
          Effect.withLogSpan("discord.verify_interaction"),
        ),
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
        yield* Effect.logInfo("http.dev.arena.start");
        const arena = yield* ArenaService;
        const payload = yield* parseJson<{ channelId: string; topic: string; agentIds?: string[] }>(
          request,
        ).pipe(Effect.orDie);
        const result = yield* arena.startArena(payload);
        return result;
      }).pipe(
        Effect.annotateLogs({ requestId, route: "/dev/arena/start" }),
        Effect.withLogSpan("http.dev.arena.start"),
      );

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
        yield* Effect.logInfo("http.dev.room.create");
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

      const result = await runtime.runPromise(
        program.pipe(
          Effect.annotateLogs({ requestId, route: "/dev/room/create", parentChannelId }),
          Effect.withLogSpan("http.dev.room.create"),
        ),
      );
      ctx.waitUntil(env.ARENA_QUEUE.send(result.firstJob));
      return json(200, { roomId: result.roomId, threadId: result.threadId });
    }

    if (url.pathname === "/dev/arena/stop" && request.method === "POST") {
      const program = Effect.gen(function* () {
        yield* Effect.logInfo("http.dev.arena.stop");
        const arena = yield* ArenaService;
        const payload = yield* parseJson<{ roomId?: number; arenaId?: number }>(request).pipe(
          Effect.orDie,
        );
        const roomId = payload.roomId ?? payload.arenaId;
        if (roomId === undefined) {
          return yield* Effect.dieMessage("Missing roomId");
        }
        yield* arena.stopArena(roomId);
        return { ok: true, roomId };
      }).pipe(
        Effect.annotateLogs({ requestId, route: "/dev/arena/stop" }),
        Effect.withLogSpan("http.dev.arena.stop"),
      );

      return json(200, await runtime.runPromise(program));
    }

    return text(404, "Not Found");
  },

  async queue(batch: MessageBatch<RoomTurnJob>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const runtime = makeRuntime(env);

    for (const message of batch.messages) {
      try {
        const job = message.body as RoomTurnJob;

        const annotations = {
          queue: batch.queue,
          queueMessageId: message.id,
          attempts: message.attempts,
          roomId: job.roomId,
          turnNumber: job.turnNumber,
        };

        const program = Effect.gen(function* () {
          yield* Effect.logInfo("queue.turn");
          const arena = yield* ArenaService;
          const next = yield* arena.processTurn(job);
          if (next) {
            yield* Effect.logInfo("queue.turn.next").pipe(
              Effect.annotateLogs({ nextTurnNumber: next.turnNumber }),
            );
          }
          return next;
        }).pipe(Effect.annotateLogs(annotations), Effect.withLogSpan("queue.turn"));

        const next = await runtime.runPromise(program);
        if (next) {
          await env.ARENA_QUEUE.send(next);

          // Persist an enqueue marker so a redelivered message (e.g., crash between send+ack)
          // doesn't re-enqueue duplicates.
          const markEnqueued = Effect.gen(function* () {
            yield* Effect.logDebug("queue.mark_enqueued");
            const { db } = yield* Db;
            yield* Effect.tryPromise({
              try: () =>
                db
                  .update(rooms)
                  .set({
                    lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${next.turnNumber})`,
                  })
                  .where(eq(rooms.id, next.roomId))
                  .run(),
              catch: () => null,
            });
          }).pipe(Effect.annotateLogs(annotations), Effect.withLogSpan("queue.mark_enqueued"));

          await runtime.runPromise(markEnqueued);
        }

        message.ack();
      } catch (e) {
        console.error("queue turn failed", e);
        message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
      }
    }
  },
};
