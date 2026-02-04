import { asc, desc, eq, sql } from "drizzle-orm";
import type { APIInteraction } from "discord-api-types/v10";
import * as ConfigProvider from "effect/ConfigProvider";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { Db } from "./d1/db.js";
import {
  agents,
  discordChannels,
  messages,
  roomAgents,
  rooms,
  roomTurnEvents,
} from "./d1/schema.js";
import { ArenaService, type RoomTurnJob, type TurnJob } from "./services/ArenaService.js";
import {
  Discord,
  type DiscordAutoArchiveDurationMinutes,
  verifyDiscordInteraction,
} from "./services/Discord.js";
import { DiscordWebhookPoster } from "./services/DiscordWebhook.js";
import { LlmRouterLive } from "./services/LlmRouter.js";
import { Observability } from "./services/Observability.js";
import { TurnEventService } from "./services/TurnEventService.js";

export interface Env {
  DB: D1Database;
  ARENA_QUEUE: Queue<RoomTurnJob>;

  // Optional runtime config (usually provided via .dev.vars / wrangler secrets)
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_BOT_USER_ID?: string;

  // Optional Cloudflare dashboard deep links (used by admin UI)
  CF_ACCOUNT_ID?: string;
  CF_WORKER_SERVICE?: string;
  CF_QUEUE_NAME?: string;
  CF_D1_NAME?: string;

  // LLM providers
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_HTTP_REFERER?: string;
  OPENROUTER_TITLE?: string;
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
    "DISCORD_BOT_USER_ID",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_HTTP_REFERER",
    "OPENROUTER_TITLE",
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
    TurnEventService.layer.pipe(Layer.provide(dbLayer)),
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

      const AgentProviderSchema = Schema.Literal("openai", "anthropic", "gemini", "openrouter");

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
        title: Schema.optional(Schema.String),
        audienceSlotDurationSeconds: Schema.optional(Schema.Number),
        audienceTokenLimit: Schema.optional(Schema.Number),
        roomTokenLimit: Schema.optional(Schema.Number),
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
              ...(body.title !== undefined ? { title: body.title } : {}),
              ...(body.audienceSlotDurationSeconds !== undefined
                ? { audienceSlotDurationSeconds: body.audienceSlotDurationSeconds }
                : {}),
              ...(body.audienceTokenLimit !== undefined
                ? { audienceTokenLimit: body.audienceTokenLimit }
                : {}),
              ...(body.roomTokenLimit !== undefined ? { roomTokenLimit: body.roomTokenLimit } : {}),
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

        // /admin/rooms/:id/events
        if (segments.length === 4 && segments[1] === "rooms" && segments[3] === "events") {
          const roomId = Number(segments[2]);
          if (!Number.isFinite(roomId)) return json(400, { error: "Invalid room id" });

          if (request.method !== "GET") return json(405, { error: "Method not allowed" });

          const rows = yield* dbTry(() =>
            db
              .select()
              .from(roomTurnEvents)
              .where(eq(roomTurnEvents.roomId, roomId))
              .orderBy(asc(roomTurnEvents.turnNumber), asc(roomTurnEvents.createdAtMs))
              .all(),
          );

          return json(200, { roomId, events: rows });
        }

        // /admin/rooms/:id/unlock | /admin/rooms/:id/pause | /admin/rooms/:id/resume | /admin/rooms/:id/kick
        if (segments.length === 4 && segments[1] === "rooms") {
          const roomId = Number(segments[2]);
          if (!Number.isFinite(roomId)) return json(400, { error: "Invalid room id" });

          if (request.method !== "POST") return json(405, { error: "Method not allowed" });

          const action = segments[3];

          if (action === "unlock") {
            const discord = yield* Discord;

            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            const threadId = room.threadId;

            return yield* discord.unlockThread(threadId).pipe(
              Effect.tap(() =>
                Effect.logInfo("admin.room.unlock_thread.success").pipe(
                  Effect.annotateLogs({ roomId, threadId }),
                ),
              ),
              Effect.as(json(200, { success: true, roomId, threadId })),
              Effect.catchAll((e) =>
                Effect.logError("admin.room.unlock_thread.failed").pipe(
                  Effect.annotateLogs({ roomId, threadId, error: String(e) }),
                  Effect.as(json(502, { success: false, roomId, threadId, error: e })),
                ),
              ),
            );
          }

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
              const job: TurnJob = { type: "turn", roomId, turnNumber: nextTurnNumber };
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

          if (action === "kick") {
            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
            );
            if (!room) {
              return yield* Effect.fail(
                AdminNotFound.make({ resource: "room", id: String(roomId) }),
              );
            }

            if (room.status !== "active") {
              return json(409, { error: "Room is paused", ok: false, enqueued: false });
            }

            const nextTurnNumber = room.currentTurnNumber + 1;

            // Prevent accidental duplicates while the room is actively progressing.
            // Only allow kick when the room looks stale (no recent messages recorded).
            const lastMsg = yield* dbTry(() =>
              db
                .select({ createdAtMs: messages.createdAtMs })
                .from(messages)
                .where(eq(messages.roomId, roomId))
                .orderBy(desc(messages.createdAtMs))
                .get(),
            );

            const now = Date.now();
            const ageMs = lastMsg ? now - Number(lastMsg.createdAtMs) : Number.POSITIVE_INFINITY;
            if (ageMs < 15_000) {
              return json(409, {
                error: "Room not stale (refusing to kick)",
                ok: false,
                enqueued: false,
                nextTurnNumber,
              });
            }

            const job: TurnJob = { type: "turn", roomId, turnNumber: nextTurnNumber };

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

            return json(200, { ok: true, enqueued: true, turnNumber: nextTurnNumber });
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

    // Discord interactions (slash commands)
    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      const publicKey = env.DISCORD_PUBLIC_KEY;
      if (!publicKey) return json(500, { error: "Missing DISCORD_PUBLIC_KEY" });

      const respond = (content: string) =>
        json(200, {
          // CHANNEL_MESSAGE_WITH_SOURCE
          type: 4,
          data: {
            content,
            // EPHEMERAL
            flags: 64,
          },
        });

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

      const interaction = (await request.json()) as APIInteraction;

      // PING -> PONG
      if (interaction.type === 1) {
        return json(200, { type: 1 });
      }

      // APPLICATION_COMMAND
      if (interaction.type !== 2) {
        return respond("Agon: unsupported interaction type.");
      }

      const threadId = (interaction as unknown as { channel_id?: unknown }).channel_id;
      const commandName = (interaction as unknown as { data?: { name?: unknown } }).data?.name;

      if (typeof threadId !== "string" || typeof commandName !== "string") {
        return respond("Agon: malformed command payload.");
      }

      type SlashResult = {
        readonly content: string;
        readonly enqueue?: RoomTurnJob;
        readonly background?: Effect.Effect<void, never, never>;
      };
      type InteractionDbError = { readonly _tag: "InteractionDbError"; readonly cause: unknown };

      const reply = (content: string, enqueue?: RoomTurnJob): SlashResult =>
        enqueue ? { content, enqueue } : { content };

      const replyBg = (
        content: string,
        background: Effect.Effect<void, never, never>,
      ): SlashResult => ({
        content,
        background,
      });

      const withBackground = (
        result: SlashResult,
        background: Effect.Effect<void, never, never>,
      ): SlashResult => ({ ...result, background });

      const dbTryInteraction = <A>(thunk: () => Promise<A>) =>
        Effect.tryPromise({
          try: thunk,
          catch: (cause): InteractionDbError => ({ _tag: "InteractionDbError", cause }),
        });

      const program = Effect.gen(function* () {
        const { db } = yield* Db;
        const discord = yield* Discord;

        const room = yield* dbTryInteraction(() =>
          db.select().from(rooms).where(eq(rooms.threadId, threadId)).get(),
        );

        if (!room) {
          return reply(
            "Agon: no room found for this thread. Please run the command inside an Agon room thread.",
          );
        }

        const roomId = room.id;
        const name = commandName.toLowerCase();

        const loadRoom = () =>
          dbTryInteraction(() => db.select().from(rooms).where(eq(rooms.id, roomId)).get());

        const enqueueNextTurn = Effect.fn("DiscordSlash.enqueueNextTurn")(() =>
          Effect.gen(function* () {
            const fresh = yield* loadRoom();
            if (!fresh) {
              return reply("Agon: room not found (it may have been deleted).");
            }

            const nextTurnNumber = fresh.currentTurnNumber + 1;

            if (fresh.lastEnqueuedTurnNumber >= nextTurnNumber) {
              return reply(`Agon: turn #${nextTurnNumber} is already enqueued.`);
            }

            yield* dbTryInteraction(() =>
              db
                .update(rooms)
                .set({
                  lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${nextTurnNumber})`,
                })
                .where(eq(rooms.id, roomId))
                .run(),
            );

            return reply(`Agon: enqueued next turn (#${nextTurnNumber}).`, {
              type: "turn",
              roomId,
              turnNumber: nextTurnNumber,
            });
          }),
        );

        switch (name) {
          case "next": {
            const fresh = yield* loadRoom();
            if (!fresh) {
              return reply("Agon: room not found (it may have been deleted).");
            }
            if (fresh.status !== "active") {
              return reply("Agon: room is paused. Use /continue to resume.");
            }
            return yield* enqueueNextTurn();
          }

          case "stop": {
            yield* dbTryInteraction(() =>
              db.update(rooms).set({ status: "paused" }).where(eq(rooms.id, roomId)).run(),
            );

            // Best-effort: unlock thread (in the background to avoid Discord's 3s interaction timeout)
            const background = discord
              .unlockThread(threadId)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.logWarning("discord.thread.unlock.failed").pipe(
                    Effect.annotateLogs({ requestId, roomId, threadId, error: String(e) }),
                    Effect.asVoid,
                  ),
                ),
              );

            return replyBg("Agon: room paused and thread unlocked.", background);
          }

          case "audience": {
            // Stop the auto-loop by pausing the room; unlock the thread so humans can speak.
            yield* dbTryInteraction(() =>
              db.update(rooms).set({ status: "paused" }).where(eq(rooms.id, roomId)).run(),
            );

            const background = discord
              .unlockThread(threadId)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.logWarning("discord.thread.unlock.failed").pipe(
                    Effect.annotateLogs({ requestId, roomId, threadId, error: String(e) }),
                    Effect.asVoid,
                  ),
                ),
              );

            return replyBg(
              "Agon: audience slot opened (room paused, thread unlocked). Use /continue to resume.",
              background,
            );
          }

          case "continue": {
            // Resume the loop and close the audience slot.
            yield* dbTryInteraction(() =>
              db.update(rooms).set({ status: "active" }).where(eq(rooms.id, roomId)).run(),
            );

            // Best-effort: lock thread in the background (the turn handler also locks during processing)
            const background = discord
              .lockThread(threadId)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.logWarning("discord.thread.lock.failed").pipe(
                    Effect.annotateLogs({ requestId, roomId, threadId, error: String(e) }),
                    Effect.asVoid,
                  ),
                ),
              );

            const enqueued = yield* enqueueNextTurn();
            return withBackground(enqueued, background);
          }

          default:
            return reply(
              `Agon: unknown command: /${commandName}. Available: /next, /stop, /audience, /continue.`,
            );
        }
      }).pipe(
        Effect.annotateLogs({ requestId, route: "/discord/interactions", threadId, commandName }),
        Effect.withLogSpan("discord.slash_command"),
      );

      const result = await runtime.runPromise(
        program.pipe(
          Effect.catchAll((e) =>
            Effect.gen(function* () {
              yield* Effect.logError("discord.slash_command.db_error").pipe(
                Effect.annotateLogs({
                  requestId,
                  threadId,
                  commandName,
                  cause: String((e as InteractionDbError).cause),
                }),
              );

              return reply("Agon: failed to handle command. Please try again or contact an admin.");
            }),
          ),
        ),
      );

      const response = respond(result.content);

      if (result.enqueue) {
        ctx.waitUntil(env.ARENA_QUEUE.send(result.enqueue));
      }

      if (result.background) {
        ctx.waitUntil(Effect.runPromise(result.background));
      }

      return response;
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

    const normalizeJob = (raw: unknown): RoomTurnJob => {
      if (typeof raw === "object" && raw !== null && "type" in raw) {
        return raw as RoomTurnJob;
      }
      const r = raw as { readonly roomId: number; readonly turnNumber: number };
      return { type: "turn", roomId: r.roomId, turnNumber: r.turnNumber };
    };

    const sendJob = async (job: RoomTurnJob): Promise<void> => {
      if (job.type === "close_audience_slot") {
        await env.ARENA_QUEUE.send(job, { delaySeconds: job.delaySeconds });
      } else {
        await env.ARENA_QUEUE.send(job);
      }
    };

    for (const message of batch.messages) {
      try {
        const job = normalizeJob(message.body);

        const annotations = {
          queue: batch.queue,
          queueMessageId: message.id,
          attempts: message.attempts,
          jobType: job.type,
          roomId: job.roomId,
          turnNumber: job.turnNumber,
        };

        const program =
          job.type === "close_audience_slot"
            ? Effect.gen(function* () {
                yield* Effect.logInfo("queue.audience_slot.close");

                const { db } = yield* Db;
                const discord = yield* Discord;
                const turnEvents = yield* TurnEventService;

                const room = yield* Effect.tryPromise({
                  try: () => db.select().from(rooms).where(eq(rooms.id, job.roomId)).get(),
                  catch: (e) => e,
                }).pipe(Effect.orDie);

                if (!room) return null;

                // If the room was manually paused/resumed, or already advanced, do nothing.
                if (room.status !== "audience_slot" && room.status !== "active") return null;
                if (room.currentTurnNumber !== job.turnNumber) return null;

                // Best-effort: lock the thread.
                yield* discord.lockThread(room.threadId).pipe(
                  Effect.catchAll((e) =>
                    Effect.logWarning("discord.thread.lock.failed").pipe(
                      Effect.annotateLogs({
                        roomId: room.id,
                        threadId: room.threadId,
                        error: String(e),
                      }),
                      Effect.asVoid,
                    ),
                  ),
                  Effect.asVoid,
                );

                const nextTurnNumber = room.currentTurnNumber + 1;
                if (room.lastEnqueuedTurnNumber >= nextTurnNumber) {
                  yield* turnEvents.write({
                    roomId: room.id,
                    turnNumber: job.turnNumber,
                    phase: "audience_slot_close",
                    status: "info",
                    data: { skippedEnqueue: true, nextTurnNumber },
                  });
                  return null;
                }

                yield* Effect.tryPromise({
                  try: () =>
                    db.update(rooms).set({ status: "active" }).where(eq(rooms.id, room.id)).run(),
                  catch: (e) => e,
                }).pipe(Effect.orDie);

                yield* turnEvents.write({
                  roomId: room.id,
                  turnNumber: job.turnNumber,
                  phase: "audience_slot_close",
                  status: "ok",
                  data: { nextTurnNumber },
                });

                return { type: "turn", roomId: room.id, turnNumber: nextTurnNumber } as const;
              }).pipe(
                Effect.annotateLogs(annotations),
                Effect.withLogSpan("queue.audience_slot.close"),
              )
            : Effect.gen(function* () {
                yield* Effect.logInfo("queue.turn");
                const arena = yield* ArenaService;
                const next = yield* arena.processTurn(job as TurnJob);
                if (next) {
                  yield* Effect.logInfo("queue.turn.next").pipe(
                    Effect.annotateLogs({
                      nextTurnNumber: next.turnNumber,
                      nextJobType: next.type,
                    }),
                  );
                }
                return next;
              }).pipe(Effect.annotateLogs(annotations), Effect.withLogSpan("queue.turn"));

        const next = await runtime.runPromise(program);
        if (next) {
          await sendJob(next);

          if (next.type === "turn") {
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
        }

        message.ack();
      } catch (e) {
        console.error("queue message failed", e);
        message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
      }
    }
  },
};
