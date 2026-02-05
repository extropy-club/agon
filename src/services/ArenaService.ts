import { buildPrompt } from "../lib/promptBuilder.js";
import { retryWithBackoff } from "../lib/retry.js";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { Config, Context, Effect, Either, Layer, Schema } from "effect";
import { Db, nowMs } from "../d1/db.js";
import { agents, discordChannels, messages, roomAgents, rooms } from "../d1/schema.js";
import {
  Discord,
  DiscordApiError,
  DiscordRateLimited,
  type DiscordError,
  MissingDiscordConfig,
} from "./Discord.js";
import { DiscordWebhookPostFailed, DiscordWebhookPoster } from "./DiscordWebhook.js";
import { type LlmRouterError, LlmRouter } from "./LlmRouter.js";
import { TurnEventService } from "./TurnEventService.js";

export type TurnJob = {
  readonly type: "turn";
  readonly roomId: number;
  readonly turnNumber: number;
};

export type CloseAudienceSlotJob = {
  readonly type: "close_audience_slot";
  readonly roomId: number;
  /**
   * The last processed agent turn number (used for idempotency).
   */
  readonly turnNumber: number;
  /**
   * Delay used when enqueuing this job via CF Queues.
   */
  readonly delaySeconds: number;
};

export type RoomTurnJob = TurnJob | CloseAudienceSlotJob;

export class RoomNotFound extends Schema.TaggedError<RoomNotFound>()("RoomNotFound", {
  roomId: Schema.Int.pipe(Schema.nonNegative(), Schema.finite(), Schema.nonNaN()),
}) {}

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()("AgentNotFound", {
  agentId: Schema.NonEmptyString,
}) {}

export class RoomDbError extends Schema.TaggedError<RoomDbError>()("RoomDbError", {
  cause: Schema.Defect,
}) {}

export type ArenaError =
  | RoomNotFound
  | AgentNotFound
  | RoomDbError
  | LlmRouterError
  | DiscordApiError
  | DiscordRateLimited
  | MissingDiscordConfig
  | DiscordWebhookPostFailed;

const dbTry = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => RoomDbError.make({ cause }),
  });

const errorLabel = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "_tag" in e) {
    const t = (e as { readonly _tag?: unknown })._tag;
    if (typeof t === "string") return t;
  }
  return String(e);
};

/** Stringify a cause value, handling nested Error objects and Effect failures. */
const stringifyCause = (c: unknown): string => {
  if (c instanceof Error) {
    const base = `${c.name}: ${c.message}`;
    return c.cause ? `${base} [caused by: ${stringifyCause(c.cause)}]` : base;
  }
  if (typeof c === "string") return c;
  if (typeof c === "object" && c !== null) {
    // Effect Cause / tagged errors
    const tag = (c as Record<string, unknown>)._tag;
    const msg = (c as Record<string, unknown>).message;
    if (typeof tag === "string") {
      const inner = (c as Record<string, unknown>).cause;
      const base = typeof msg === "string" ? `${tag}: ${msg}` : tag;
      return inner ? `${base} [caused by: ${stringifyCause(inner)}]` : base;
    }
    try {
      const s = JSON.stringify(c);
      return s.length <= 500 ? s : s.slice(0, 500) + "…";
    } catch {
      return String(c);
    }
  }
  return String(c);
};

/** Richer error serialization for turn event data — captures cause, status, message, etc. */
const errorDetail = (e: unknown): Record<string, unknown> => {
  const detail: Record<string, unknown> = { _tag: errorLabel(e) };
  if (typeof e !== "object" || e === null) {
    detail.value = String(e);
    return detail;
  }
  const obj = e as Record<string, unknown>;
  if ("cause" in obj) detail.cause = stringifyCause(obj.cause);
  if ("status" in obj && typeof obj.status === "number") detail.status = obj.status;
  if ("provider" in obj) detail.provider = obj.provider;
  if ("model" in obj) detail.model = obj.model;
  if ("envVar" in obj) detail.envVar = obj.envVar;
  if ("message" in obj && typeof obj.message === "string") detail.message = obj.message;
  if ("retryAfterMs" in obj) detail.retryAfterMs = obj.retryAfterMs;
  return detail;
};

const turnFailedNotification = "⚠️ Turn failed — skipping to next agent.";

const isRetryableDiscordError = (e: DiscordError): boolean => {
  switch (e._tag) {
    case "MissingDiscordConfig":
      return false;
    case "DiscordRateLimited":
      return true;
    case "DiscordApiError":
      return e.status === 0 || e.status === 429 || e.status >= 500;
  }
};

const discordRetryAfterMs = (e: DiscordError): number | undefined =>
  e._tag === "DiscordRateLimited" ? e.retryAfterMs : undefined;

const isRetryableDiscordWebhookError = (e: DiscordWebhookPostFailed): boolean =>
  e.status === 0 || e.status === 429 || e.status >= 500;

const isRetryableLlmError = (e: LlmRouterError): boolean => {
  switch (e._tag) {
    case "MissingLlmApiKey":
      return false;

    case "LlmContentError":
      // Provider returned an unexpected response shape.
      // Treat as transient (provider hiccup) and retry.
      return true;

    case "LlmCallFailed": {
      const s = String(e.cause).toLowerCase();

      // auth / config
      if (
        s.includes(" 401") ||
        s.includes("401") ||
        s.includes(" 403") ||
        s.includes("403") ||
        s.includes("unauthorized") ||
        s.includes("forbidden") ||
        s.includes("invalid api key") ||
        s.includes("authentication")
      ) {
        return false;
      }

      // validation / prompt issues
      if (
        s.includes(" 400") ||
        s.includes("400") ||
        s.includes("bad request") ||
        s.includes("invalid prompt") ||
        s.includes("validation")
      ) {
        return false;
      }

      // not found
      if (s.includes("404") || s.includes("not found")) {
        return false;
      }

      // retryable
      if (s.includes(" 429") || s.includes("429") || s.includes("rate limit")) return true;
      if (s.includes("timeout") || s.includes("timed out")) return true;
      if (/\b5\d\d\b/.test(s)) return true;

      // default: treat unknown defects as transient (network, provider hiccups)
      return true;
    }
  }
};

const defaultAgents: ReadonlyArray<{
  id: string;
  name: string;
  avatarUrl?: string;
  systemPrompt: string;
  llmProvider: "openai" | "anthropic" | "gemini";
  llmModel: string;
}> = [
  {
    id: "aristotle",
    name: "Aristotle",
    avatarUrl: "https://i.imgur.com/1X0xJtW.png",
    systemPrompt:
      "You are Aristotle. You speak formally and with careful logic. Keep answers concise. Ask one probing question at the end.",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
  },
  {
    id: "newton",
    name: "Isaac Newton",
    avatarUrl: "https://i.imgur.com/S7yqJmC.png",
    systemPrompt:
      "You are Isaac Newton. You are precise and mathematical. Prefer definitions and short derivations. Keep answers concise.",
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
  },
];

const formatModeratorMessage = (args: { title: string; topic: string }) =>
  `📢 **${args.title}**\n\n${args.topic}\n\n**Rules:**\n- Stay on topic\n- No meta talk about being an AI\n- Aim for 5-10 sentences\n- Say 'Goodbye' to end the debate\n\nDebate begins now!`;

const isModeratorMessage = (content: string) =>
  content.startsWith("📢 **") &&
  content.includes("**Rules:**") &&
  content.includes("Debate begins now!");

export class ArenaService extends Context.Tag("@agon/ArenaService")<
  ArenaService,
  {
    /**
     * DEV endpoint (legacy): uses `channelId` as both parentChannelId and threadId.
     */
    readonly startArena: (args: {
      channelId: string;
      topic: string;
      agentIds?: ReadonlyArray<string>;
    }) => Effect.Effect<{ roomId: number; firstJob: TurnJob }, ArenaError>;

    /**
     * Create (or restart) a room bound to an existing Discord thread.
     */
    readonly createRoom: (args: {
      parentChannelId: string;
      threadId: string;
      topic: string;
      autoArchiveDurationMinutes?: number;
      agentIds?: ReadonlyArray<string>;
      title?: string;
      audienceSlotDurationSeconds?: number;
      audienceTokenLimit?: number;
      roomTokenLimit?: number;
    }) => Effect.Effect<{ roomId: number; firstJob: TurnJob }, ArenaError>;

    readonly stopArena: (roomId: number) => Effect.Effect<void, ArenaError>;

    /**
     * Process a single queued turn.
     * Returns the next job to enqueue (or null when the loop terminates).
     */
    readonly processTurn: (job: TurnJob) => Effect.Effect<RoomTurnJob | null, ArenaError>;
  }
>() {
  static readonly layer = Layer.effect(
    ArenaService,
    Effect.gen(function* () {
      const { db } = yield* Db;
      const discord = yield* Discord;
      const llmRouter = yield* LlmRouter;
      const webhookPoster = yield* DiscordWebhookPoster;
      const turnEvents = yield* TurnEventService;

      const maxTurns = yield* Config.integer("ARENA_MAX_TURNS").pipe(
        Effect.orElseSucceed(() => 30),
      );
      const historyLimit = yield* Config.integer("ARENA_HISTORY_LIMIT").pipe(
        Effect.orElseSucceed(() => 20),
      );

      const seedAgents = Effect.fn("ArenaService.seedAgents")(function* () {
        for (const a of defaultAgents) {
          const exists = yield* dbTry(() =>
            db.select({ id: agents.id }).from(agents).where(eq(agents.id, a.id)).get(),
          );
          if (!exists) {
            yield* dbTry(() => db.insert(agents).values(a).run());
          }
        }
      });

      const upsertRoom = Effect.fn("ArenaService.upsertRoom")(function* (args: {
        parentChannelId: string;
        threadId: string;
        topic: string;
        autoArchiveDurationMinutes: number;
        agentIds?: ReadonlyArray<string>;
        title?: string;
        audienceSlotDurationSeconds?: number;
        audienceTokenLimit?: number;
        roomTokenLimit?: number;
      }) {
        yield* seedAgents();

        const agentIds =
          args.agentIds && args.agentIds.length > 0
            ? args.agentIds
            : defaultAgents.map((a) => a.id);

        const firstAgentId = agentIds[0];

        // Guard against invalid values (Discord only accepts a small set).
        const allowedDurations = [60, 1440, 4320, 10080] as const;
        const autoArchiveDurationMinutes = allowedDurations.includes(
          args.autoArchiveDurationMinutes as (typeof allowedDurations)[number],
        )
          ? args.autoArchiveDurationMinutes
          : 1440;

        // Upsert room by thread id
        const existing = yield* dbTry(() =>
          db.select().from(rooms).where(eq(rooms.threadId, args.threadId)).get(),
        );

        const roomId =
          existing?.id ??
          (yield* dbTry(async () => {
            const result = await db
              .insert(rooms)
              .values({
                status: "active",
                topic: args.topic,
                title: args.title ?? "",
                parentChannelId: args.parentChannelId,
                threadId: args.threadId,
                autoArchiveDurationMinutes,
                audienceSlotDurationSeconds: args.audienceSlotDurationSeconds ?? 60,
                audienceTokenLimit: args.audienceTokenLimit ?? 4096,
                roomTokenLimit: args.roomTokenLimit ?? 32000,
                currentTurnAgentId: firstAgentId,
                currentTurnNumber: 0,
                lastEnqueuedTurnNumber: 0,
              })
              .returning({ id: rooms.id })
              .get();
            return result.id;
          }));

        // Reset room state on restart
        yield* dbTry(() =>
          db
            .update(rooms)
            .set({
              status: "active",
              topic: args.topic,
              title: args.title ?? "",
              parentChannelId: args.parentChannelId,
              threadId: args.threadId,
              autoArchiveDurationMinutes,
              audienceSlotDurationSeconds: args.audienceSlotDurationSeconds ?? 60,
              audienceTokenLimit: args.audienceTokenLimit ?? 4096,
              roomTokenLimit: args.roomTokenLimit ?? 32000,
              currentTurnAgentId: firstAgentId,
              currentTurnNumber: 0,
              lastEnqueuedTurnNumber: 0,
            })
            .where(eq(rooms.id, roomId))
            .run(),
        );

        // participants
        yield* dbTry(() => db.delete(roomAgents).where(eq(roomAgents.roomId, roomId)).run());
        for (let i = 0; i < agentIds.length; i++) {
          yield* dbTry(() =>
            db.insert(roomAgents).values({ roomId, agentId: agentIds[i], turnOrder: i }).run(),
          );
        }

        // reset history
        yield* dbTry(() => db.delete(messages).where(eq(messages.roomId, roomId)).run());

        return { roomId, firstJob: { type: "turn", roomId, turnNumber: 1 } } as const;
      });

      const startArena = Effect.fn("ArenaService.startArena")(function* (args: {
        channelId: string;
        topic: string;
        agentIds?: ReadonlyArray<string>;
      }) {
        // Legacy DEV endpoint: channelId == parentChannelId == threadId
        return yield* upsertRoom({
          parentChannelId: args.channelId,
          threadId: args.channelId,
          topic: args.topic,
          autoArchiveDurationMinutes: 1440,
          ...(args.agentIds ? { agentIds: args.agentIds } : {}),
        });
      });

      const createRoom = Effect.fn("ArenaService.createRoom")(function* (args: {
        parentChannelId: string;
        threadId: string;
        topic: string;
        autoArchiveDurationMinutes?: number;
        agentIds?: ReadonlyArray<string>;
        title?: string;
        audienceSlotDurationSeconds?: number;
        audienceTokenLimit?: number;
        roomTokenLimit?: number;
      }) {
        const providedTitle = args.title?.trim();
        const hasProvidedTitle = providedTitle !== undefined && providedTitle.length > 0;

        const result = yield* upsertRoom({
          parentChannelId: args.parentChannelId,
          threadId: args.threadId,
          topic: args.topic,
          autoArchiveDurationMinutes: args.autoArchiveDurationMinutes ?? 1440,
          ...(args.agentIds ? { agentIds: args.agentIds } : {}),
          ...(hasProvidedTitle ? { title: providedTitle! } : {}),
          ...(args.audienceSlotDurationSeconds !== undefined
            ? { audienceSlotDurationSeconds: args.audienceSlotDurationSeconds }
            : {}),
          ...(args.audienceTokenLimit !== undefined
            ? { audienceTokenLimit: args.audienceTokenLimit }
            : {}),
          ...(args.roomTokenLimit !== undefined ? { roomTokenLimit: args.roomTokenLimit } : {}),
        });

        const fetchedTitle = hasProvidedTitle
          ? ""
          : yield* discord.fetchChannelName(args.threadId).pipe(
              Effect.map((t) => t.trim()),
              Effect.catchAll(() => Effect.succeed("")),
            );

        const title = hasProvidedTitle
          ? (providedTitle as string)
          : fetchedTitle.length > 0
            ? fetchedTitle
            : `Agon Room ${result.roomId}`;

        // Only persist the Discord thread title if no title was provided and Discord returned a name.
        if (!hasProvidedTitle && fetchedTitle.length > 0) {
          yield* dbTry(() =>
            db.update(rooms).set({ title: fetchedTitle }).where(eq(rooms.id, result.roomId)).run(),
          );
        }

        const content = formatModeratorMessage({ title, topic: args.topic });

        // Post visibly in the thread as the bot (not a webhook).
        //
        // IMPORTANT: Discord can fail (bad token, permissions, rate limit, etc.). Room creation should
        // still succeed and we always insert a moderator message into D1.
        const posted = yield* discord.postMessage(args.threadId, content).pipe(
          Effect.catchTag("MissingDiscordConfig", (e) =>
            Effect.logInfo("discord.postMessage.skipped_missing_config").pipe(
              Effect.annotateLogs({ key: e.key, threadId: args.threadId, roomId: result.roomId }),
              Effect.as(null),
            ),
          ),
          Effect.catchAll((e) =>
            Effect.logWarning("discord.postMessage.failed").pipe(
              Effect.annotateLogs({
                error: errorLabel(e),
                threadId: args.threadId,
                roomId: result.roomId,
              }),
              Effect.as(null),
            ),
          ),
        );

        const parsed = posted ? Date.parse(posted.timestamp) : NaN;
        const now = yield* nowMs;
        const createdAtMs = Number.isFinite(parsed) ? parsed : now;
        const discordMessageId = posted
          ? posted.id
          : `local-moderator:${result.roomId}:${createdAtMs}`;

        // Store in D1 so it appears as the first message in agent prompts.
        yield* dbTry(() =>
          db
            .insert(messages)
            .values({
              roomId: result.roomId,
              discordMessageId,
              threadId: args.threadId,
              authorType: "moderator",
              authorAgentId: null,
              content,
              createdAtMs,
            })
            .run(),
        );

        return result;
      });

      const stopArena = Effect.fn("ArenaService.stopArena")(function* (roomId: number) {
        const existing = yield* dbTry(() =>
          db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).get(),
        );
        if (!existing) return yield* RoomNotFound.make({ roomId });
        yield* dbTry(() =>
          db.update(rooms).set({ status: "paused" }).where(eq(rooms.id, roomId)).run(),
        );
      });

      const processTurn = Effect.fn("ArenaService.processTurn")((job: TurnJob) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.logInfo("arena.turn.start").pipe(
              Effect.annotateLogs({ roomId: job.roomId, turnNumber: job.turnNumber }),
            );

            const room = yield* dbTry(() =>
              db.select().from(rooms).where(eq(rooms.id, job.roomId)).get(),
            );
            if (!room) return yield* RoomNotFound.make({ roomId: job.roomId });

            // Hard stop: manual pause.
            if (room.status === "paused") return null;

            yield* Effect.logDebug("arena.turn.room_loaded").pipe(
              Effect.annotateLogs({
                threadId: room.threadId,
                parentChannelId: room.parentChannelId,
                currentTurnNumber: room.currentTurnNumber,
              }),
            );

            // idempotency
            // - normal case: currentTurnNumber + 1 == job.turnNumber
            // - retry case: currentTurnNumber == job.turnNumber (turn was processed but enqueue/ack may have failed)
            if (room.currentTurnNumber === job.turnNumber) {
              // This is a redelivery after the turn already advanced in D1, likely due to
              // a crash between enqueue+ack.
              //
              // If the last processed turn opened an audience slot, prefer re-enqueueing the
              // close job (it's idempotent) rather than immediately advancing to the next agent.
              if (room.status === "audience_slot") {
                const audienceSlotSeconds = Math.max(0, room.audienceSlotDurationSeconds);
                if (audienceSlotSeconds > 0) {
                  yield* Effect.logInfo("arena.turn.redelivery_reenqueue_close_audience_slot");
                  return {
                    type: "close_audience_slot",
                    roomId: room.id,
                    turnNumber: job.turnNumber,
                    delaySeconds: audienceSlotSeconds,
                  } as const;
                }
              }

              const nextTurnNumber = job.turnNumber + 1;
              if (room.lastEnqueuedTurnNumber >= nextTurnNumber) {
                yield* Effect.logDebug("arena.turn.redelivery_already_enqueued");
                return null;
              }
              yield* Effect.logInfo("arena.turn.redelivery_reenqueue_next");
              return { type: "turn", roomId: room.id, turnNumber: nextTurnNumber } as const;
            }
            if (room.currentTurnNumber + 1 !== job.turnNumber) {
              yield* Effect.logDebug("arena.turn.idempotent_drop");
              return null;
            }

            // Audience slot (and other non-active states) intentionally stop the auto-loop.
            if (room.status !== "active") return null;

            const agent = yield* dbTry(() =>
              db.select().from(agents).where(eq(agents.id, room.currentTurnAgentId)).get(),
            );
            if (!agent) return yield* AgentNotFound.make({ agentId: room.currentTurnAgentId });

            yield* turnEvents.write({
              roomId: room.id,
              turnNumber: job.turnNumber,
              phase: "start",
              status: "info",
              data: { agentId: agent.id, threadId: room.threadId },
            });

            const notifyFinalFailure = (
              source: string,
              error: unknown,
            ): Effect.Effect<void, never> =>
              discord.postMessage(room.threadId, turnFailedNotification).pipe(
                (eff) =>
                  retryWithBackoff(eff, {
                    maxRetries: 3,
                    isRetryable: isRetryableDiscordError,
                    getRetryAfterMs: discordRetryAfterMs,
                  }),
                Effect.tap(() =>
                  turnEvents.write({
                    roomId: room.id,
                    turnNumber: job.turnNumber,
                    phase: "final_failure_notify",
                    status: "ok",
                    data: { source },
                  }),
                ),
                Effect.catchAll((notifyErr) =>
                  turnEvents
                    .write({
                      roomId: room.id,
                      turnNumber: job.turnNumber,
                      phase: "final_failure_notify",
                      status: "fail",
                      data: {
                        source,
                        error: errorLabel(notifyErr),
                        originalError: errorLabel(error),
                      },
                    })
                    .pipe(Effect.asVoid),
                ),
                Effect.asVoid,
              );

            // webhook info (used for both sync classification and posting)
            const webhook = yield* dbTry(() =>
              db
                .select()
                .from(discordChannels)
                .where(eq(discordChannels.channelId, room.parentChannelId))
                .get(),
            );

            const logThreadWarning = (action: "lock" | "unlock") => (e: unknown) =>
              Effect.logWarning(`discord.thread.${action}.failed`).pipe(
                Effect.annotateLogs({
                  error: errorLabel(e),
                  roomId: room.id,
                  threadId: room.threadId,
                  turnNumber: job.turnNumber,
                }),
                Effect.asVoid,
              );

            // Lock the thread for the duration of agent processing.
            //
            // Errors are logged but must not fail the turn.
            yield* Effect.acquireRelease(
              retryWithBackoff(discord.lockThread(room.threadId), {
                maxRetries: 3,
                isRetryable: isRetryableDiscordError,
                getRetryAfterMs: discordRetryAfterMs,
              }).pipe(Effect.catchAll(logThreadWarning("lock")), Effect.as(room.threadId)),
              (threadId) =>
                retryWithBackoff(discord.unlockThread(threadId), {
                  maxRetries: 3,
                  isRetryable: isRetryableDiscordError,
                  getRetryAfterMs: discordRetryAfterMs,
                }).pipe(Effect.catchAll(logThreadWarning("unlock")), Effect.asVoid),
            );

            // Sync recent Discord thread history into D1.
            //
            // If DISCORD_BOT_TOKEN is missing, Discord.fetchRecentMessages fails with
            // MissingDiscordConfig — we intentionally skip sync and keep using D1-only history.
            //
            // Any other Discord API failure should fail the turn (and let the queue retry),
            // because Discord is the source of truth for room history.
            const discordMessages = yield* retryWithBackoff(
              discord.fetchRecentMessages(room.threadId, historyLimit),
              {
                maxRetries: 3,
                isRetryable: isRetryableDiscordError,
                getRetryAfterMs: discordRetryAfterMs,
              },
            ).pipe(
              Effect.tap((msgs) =>
                turnEvents.write({
                  roomId: room.id,
                  turnNumber: job.turnNumber,
                  phase: "discord_sync",
                  status: "ok",
                  data: { fetched: msgs.length },
                }),
              ),
              Effect.catchTag("MissingDiscordConfig", () =>
                turnEvents
                  .write({
                    roomId: room.id,
                    turnNumber: job.turnNumber,
                    phase: "discord_sync",
                    status: "info",
                    data: { skipped: true },
                  })
                  .pipe(Effect.as(null)),
              ),
              Effect.tapError((e) =>
                turnEvents.write({
                  roomId: room.id,
                  turnNumber: job.turnNumber,
                  phase: "discord_sync",
                  status: "fail",
                  data: {
                    error: errorLabel(e),
                    detail: errorDetail(e),
                  },
                }),
              ),
              Effect.withLogSpan("discord.sync"),
            );

            yield* Effect.logDebug("discord.sync.fetched").pipe(
              Effect.annotateLogs({
                discordFetched: discordMessages ? discordMessages.length : 0,
              }),
            );

            if (discordMessages) {
              const agentNameToId = new Map(
                (yield* dbTry(() =>
                  db.select({ id: agents.id, name: agents.name }).from(agents).all(),
                )).map((a) => [a.name, a.id] as const),
              );

              const ordered = discordMessages
                .map((m) => ({ m, createdAtMs: Date.parse(m.timestamp) }))
                .filter((x) => Number.isFinite(x.createdAtMs))
                .sort((a, b) => a.createdAtMs - b.createdAtMs);

              yield* Effect.logDebug("discord.sync.upsert").pipe(
                Effect.annotateLogs({ discordUpserted: ordered.length }),
              );

              const needsBotUserId = ordered.some(
                ({ m }) => m.webhook_id === undefined && m.author.bot === true,
              );
              const botUserId = needsBotUserId
                ? yield* retryWithBackoff(discord.getBotUserId(), {
                    maxRetries: 3,
                    isRetryable: isRetryableDiscordError,
                    getRetryAfterMs: discordRetryAfterMs,
                  }).pipe(Effect.catchTag("MissingDiscordConfig", () => Effect.succeed(null)))
                : null;

              for (const { m, createdAtMs } of ordered) {
                const isWebhookMessage = m.webhook_id !== undefined;
                const isNotification =
                  !isWebhookMessage && botUserId !== null && m.author.id === botUserId;
                const isModerator = isNotification && isModeratorMessage(m.content);

                const authorType = isWebhookMessage
                  ? ("agent" as const)
                  : isModerator
                    ? ("moderator" as const)
                    : isNotification
                      ? ("notification" as const)
                      : ("audience" as const);

                const authorAgentId =
                  authorType === "agent" ? agentNameToId.get(m.author.username) : undefined;

                yield* dbTry(() =>
                  db
                    .insert(messages)
                    .values({
                      roomId: room.id,
                      discordMessageId: m.id,
                      threadId: room.threadId,
                      authorType,
                      authorAgentId: authorAgentId ?? null,
                      content: m.content,
                      createdAtMs,
                    })
                    .onConflictDoUpdate({
                      target: messages.discordMessageId,
                      set: {
                        roomId: room.id,
                        threadId: room.threadId,
                        authorType,
                        authorAgentId: authorAgentId ?? null,
                        content: m.content,
                        createdAtMs,
                      },
                    })
                    .run(),
                );
              }
            }

            // bounded history (timestamp-based due to sync inserts)
            // We intentionally load more than `historyLimit` so that we can filter out
            // notifications + local-turn duplicates without losing context.
            const rawHistoryLimit = Math.max(historyLimit * 3, 60);
            const rawHistory = yield* dbTry(() =>
              db
                .select()
                .from(messages)
                .where(eq(messages.roomId, room.id))
                .orderBy(desc(messages.createdAtMs), desc(messages.id))
                .limit(rawHistoryLimit)
                .all(),
            );

            const nonLocalAgentMessages = rawHistory.filter(
              (m) => m.authorType === "agent" && !m.discordMessageId.startsWith("local-turn:"),
            );

            const localTurnDedupeWindowMs = 30 * 60 * 1000;
            const localTurnDedupeAllowEarlyMs = 30 * 1000;

            const promptHistory = rawHistory
              .slice()
              .reverse()
              .filter((m) => m.authorType !== "notification")
              .filter((m) => {
                // Prefer synced Discord webhook messages over their local-turn duplicates, but
                // keep local-turn messages when we don't have a synced copy yet.
                if (m.authorType !== "agent") return true;
                if (!m.discordMessageId.startsWith("local-turn:")) return true;

                const isDuplicate = nonLocalAgentMessages.some((x) => {
                  if (x.content !== m.content) return false;
                  const dt = x.createdAtMs - m.createdAtMs;
                  if (dt < -localTurnDedupeAllowEarlyMs) return false;
                  if (dt > localTurnDedupeWindowMs) return false;
                  if (m.authorAgentId && x.authorAgentId && x.authorAgentId !== m.authorAgentId) {
                    return false;
                  }
                  return true;
                });

                return !isDuplicate;
              })
              .slice(-historyLimit);

            yield* Effect.logDebug("prompt.built").pipe(
              Effect.annotateLogs({ promptMessages: promptHistory.length }),
            );

            const agentNameById = new Map(
              (yield* dbTry(() =>
                db.select({ id: agents.id, name: agents.name }).from(agents).all(),
              )).map((a) => [a.id, a.name] as const),
            );

            const getAgentName = (agentId: string | null | undefined): string =>
              (agentId ? agentNameById.get(agentId) : undefined) ?? "Unknown";

            const getNonAgentName = (
              m: { readonly authorType: string } & Record<string, unknown>,
            ): string => {
              const explicit = m["authorName"];
              if (typeof explicit === "string" && explicit.trim().length > 0) return explicit;
              if (m.authorType === "audience") return "Audience";
              if (m.authorType === "moderator") return "Moderator";
              return "Unknown";
            };

            const prompt = buildPrompt(
              { title: room.title, topic: room.topic },
              { systemPrompt: agent.systemPrompt },
              promptHistory.map((m) => ({
                authorType: m.authorType,
                authorName:
                  m.authorType === "agent" ? getAgentName(m.authorAgentId) : getNonAgentName(m),
                content: m.content,
              })),
            );

            // deterministic id to make turn replay idempotent
            const discordMessageId = `local-turn:${room.id}:${job.turnNumber}`;

            const existingReply = yield* dbTry(() =>
              db
                .select({ content: messages.content, createdAtMs: messages.createdAtMs })
                .from(messages)
                .where(eq(messages.discordMessageId, discordMessageId))
                .get(),
            );

            let reply: string;
            let replyCreatedAtMs: number;

            if (existingReply) {
              // queue retry: reuse persisted content and skip LLM call
              reply = existingReply.content;
              replyCreatedAtMs = existingReply.createdAtMs;
              yield* Effect.logDebug("llm.generate.skip_existing").pipe(
                Effect.annotateLogs({ replyChars: reply.length }),
              );
            } else {
              // thinking delay (basic anti-spam)
              yield* Effect.sleep("3 seconds");

              yield* turnEvents.write({
                roomId: room.id,
                turnNumber: job.turnNumber,
                phase: "llm_start",
                status: "info",
                data: { llmProvider: agent.llmProvider, llmModel: agent.llmModel },
              });

              const llmResult = yield* retryWithBackoff(
                llmRouter.generate({
                  provider: agent.llmProvider,
                  model: agent.llmModel,
                  prompt,
                  ...(agent.temperature ? { temperature: parseFloat(agent.temperature) } : {}),
                  ...(agent.maxTokens != null ? { maxTokens: agent.maxTokens } : {}),
                  ...(agent.thinkingLevel != null ? { thinkingLevel: agent.thinkingLevel } : {}),
                  ...(agent.thinkingBudgetTokens != null
                    ? { thinkingBudgetTokens: agent.thinkingBudgetTokens }
                    : {}),
                }),
                { maxRetries: 3, isRetryable: isRetryableLlmError },
              ).pipe(Effect.withLogSpan("llm.generate"), Effect.either);

              if (Either.isLeft(llmResult)) {
                const e = llmResult.left;

                yield* turnEvents.write({
                  roomId: room.id,
                  turnNumber: job.turnNumber,
                  phase: "llm_fail",
                  status: "fail",
                  data: { error: errorLabel(e), detail: errorDetail(e) },
                });

                yield* notifyFinalFailure("llm", e);

                // Turn failed, but the turn loop should continue. Skip to the next agent.
                const participants = yield* dbTry(() =>
                  db
                    .select()
                    .from(roomAgents)
                    .where(eq(roomAgents.roomId, room.id))
                    .orderBy(asc(roomAgents.turnOrder))
                    .all(),
                );

                const idx = Math.max(
                  0,
                  participants.findIndex((p) => p.agentId === agent.id),
                );
                const next = participants[(idx + 1) % participants.length];

                yield* dbTry(() =>
                  db
                    .update(rooms)
                    .set({
                      status: "active",
                      currentTurnNumber: job.turnNumber,
                      currentTurnAgentId: next.agentId,
                    })
                    .where(eq(rooms.id, room.id))
                    .run(),
                );

                yield* turnEvents.write({
                  roomId: room.id,
                  turnNumber: job.turnNumber,
                  phase: "finish",
                  status: "fail",
                  data: {
                    error: errorLabel(e),
                    source: "llm",
                    detail: errorDetail(e),
                    skippedToNextAgent: true,
                    nextTurnNumber: job.turnNumber + 1,
                    nextAgentId: next.agentId,
                  },
                });

                return { type: "turn", roomId: room.id, turnNumber: job.turnNumber + 1 } as const;
              }

              reply = llmResult.right;

              yield* turnEvents.write({
                roomId: room.id,
                turnNumber: job.turnNumber,
                phase: "llm_ok",
                status: "ok",
                data: { replyChars: reply.length },
              });

              yield* Effect.logInfo("llm.generate.ok").pipe(
                Effect.annotateLogs({
                  llmProvider: agent.llmProvider,
                  llmModel: agent.llmModel,
                  replyChars: reply.length,
                }),
              );

              const now = yield* nowMs;
              replyCreatedAtMs = now;
              yield* dbTry(() =>
                db
                  .insert(messages)
                  .values({
                    roomId: room.id,
                    discordMessageId,
                    threadId: room.threadId,
                    authorType: "agent",
                    authorAgentId: agent.id,
                    content: reply,
                    createdAtMs: now,
                  })
                  .onConflictDoNothing({ target: messages.discordMessageId })
                  .run(),
              );

              // Trim history to avoid unbounded growth
              yield* dbTry(async () => {
                const countRow = await db
                  .select({ c: sql<number>`count(*)` })
                  .from(messages)
                  .where(eq(messages.roomId, room.id))
                  .get();

                const count = countRow ? Number(countRow.c) : 0;
                const maxKeep = Math.max(historyLimit * 3, 60);
                if (count <= maxKeep) return;

                const cutoff = await db
                  .select({ id: messages.id, createdAtMs: messages.createdAtMs })
                  .from(messages)
                  .where(eq(messages.roomId, room.id))
                  .orderBy(desc(messages.createdAtMs), desc(messages.id))
                  .offset(maxKeep)
                  .limit(1)
                  .get();

                if (!cutoff) return;

                await db
                  .delete(messages)
                  .where(
                    and(
                      eq(messages.roomId, room.id),
                      or(
                        lt(messages.createdAtMs, cutoff.createdAtMs),
                        and(
                          eq(messages.createdAtMs, cutoff.createdAtMs),
                          lt(messages.id, cutoff.id),
                        ),
                      ),
                    ),
                  )
                  .run();
              });
            }

            // Post to Discord if we have a webhook for this room's parent channel.
            //
            // When the queue retries a turn after we already successfully posted, we need to avoid
            // duplicating the Discord message.
            let alreadyPostedToDiscord = false;
            let alreadyPostedInDiscordThread = false;

            if (existingReply) {
              alreadyPostedToDiscord = rawHistory.some((m) => {
                if (m.authorType !== "agent") return false;
                if (m.discordMessageId.startsWith("local-turn:")) return false;
                if (m.content !== reply) return false;
                const dt = m.createdAtMs - replyCreatedAtMs;
                if (dt < -localTurnDedupeAllowEarlyMs) return false;
                if (dt > localTurnDedupeWindowMs) return false;
                if (m.authorAgentId !== agent.id) return false;
                return true;
              });

              alreadyPostedInDiscordThread =
                !alreadyPostedToDiscord &&
                !!discordMessages &&
                discordMessages.some((m) => {
                  if (m.webhook_id === undefined) return false;
                  if (m.content !== reply) return false;
                  if (m.author.username !== agent.name) return false;
                  const createdAtMs = Date.parse(m.timestamp);
                  if (!Number.isFinite(createdAtMs)) return false;
                  const dt = createdAtMs - replyCreatedAtMs;
                  if (dt < -localTurnDedupeAllowEarlyMs) return false;
                  if (dt > localTurnDedupeWindowMs) return false;
                  return true;
                });
            }

            if (webhook && !(alreadyPostedToDiscord || alreadyPostedInDiscordThread)) {
              const postResult = yield* retryWithBackoff(
                webhookPoster.post({
                  webhook: { id: webhook.webhookId, token: webhook.webhookToken },
                  threadId: room.threadId,
                  content: reply,
                  username: agent.name,
                  ...(agent.avatarUrl ? { avatarUrl: agent.avatarUrl } : {}),
                }),
                { maxRetries: 3, isRetryable: isRetryableDiscordWebhookError },
              ).pipe(Effect.withLogSpan("discord.webhook.post"), Effect.either);

              if (Either.isLeft(postResult)) {
                const e = postResult.left;

                yield* turnEvents.write({
                  roomId: room.id,
                  turnNumber: job.turnNumber,
                  phase: "webhook_post_fail",
                  status: "fail",
                  data: { error: errorLabel(e), detail: errorDetail(e) },
                });

                yield* notifyFinalFailure("webhook_post", e);

                yield* turnEvents.write({
                  roomId: room.id,
                  turnNumber: job.turnNumber,
                  phase: "finish",
                  status: "fail",
                  data: { error: errorLabel(e), source: "webhook_post", detail: errorDetail(e) },
                });

                // Do not return: the reply is already persisted in D1. We'll advance the turn
                // normally so the loop continues, and Discord will catch up on the next sync.
              } else {
                yield* turnEvents.write({
                  roomId: room.id,
                  turnNumber: job.turnNumber,
                  phase: "webhook_post_ok",
                  status: "ok",
                });

                yield* Effect.logInfo("discord.webhook.posted");
              }
            } else if (webhook) {
              yield* Effect.logDebug("discord.webhook.skip_duplicate");
            } else {
              yield* Effect.logDebug("discord.webhook.skip_missing");
            }

            const shouldStop =
              reply.toLowerCase().includes("goodbye") || job.turnNumber >= maxTurns;
            if (shouldStop) {
              yield* dbTry(() =>
                db
                  .update(rooms)
                  .set({ status: "paused", currentTurnNumber: job.turnNumber })
                  .where(eq(rooms.id, room.id))
                  .run(),
              );

              yield* turnEvents.write({
                roomId: room.id,
                turnNumber: job.turnNumber,
                phase: "finish",
                status: "ok",
                data: { stopped: true },
              });

              return null;
            }

            const participants = yield* dbTry(() =>
              db
                .select()
                .from(roomAgents)
                .where(eq(roomAgents.roomId, room.id))
                .orderBy(asc(roomAgents.turnOrder))
                .all(),
            );

            const idx = Math.max(
              0,
              participants.findIndex((p) => p.agentId === agent.id),
            );
            const next = participants[(idx + 1) % participants.length];

            const isEndOfAgentCycle = idx === participants.length - 1;
            const audienceSlotSeconds = Math.max(0, room.audienceSlotDurationSeconds);
            const shouldOpenAudienceSlot = isEndOfAgentCycle && audienceSlotSeconds > 0;

            if (shouldOpenAudienceSlot) {
              // We finished a full agent cycle; open the audience slot and pause the auto loop.
              yield* dbTry(() =>
                db
                  .update(rooms)
                  .set({
                    status: "audience_slot",
                    currentTurnNumber: job.turnNumber,
                    currentTurnAgentId: next.agentId,
                  })
                  .where(eq(rooms.id, room.id))
                  .run(),
              );

              // Best-effort: ensure the thread is unlocked for the audience slot.
              yield* retryWithBackoff(discord.unlockThread(room.threadId), {
                maxRetries: 3,
                isRetryable: isRetryableDiscordError,
                getRetryAfterMs: discordRetryAfterMs,
              }).pipe(Effect.catchAll(logThreadWarning("unlock")));

              const notificationContent = `💬 Audience slot open (${audienceSlotSeconds}s) - share your thoughts!`;

              const posted = yield* discord.postMessage(room.threadId, notificationContent).pipe(
                (eff) =>
                  retryWithBackoff(eff, {
                    maxRetries: 3,
                    isRetryable: isRetryableDiscordError,
                    getRetryAfterMs: discordRetryAfterMs,
                  }),
                Effect.catchTag("MissingDiscordConfig", (e) =>
                  Effect.logInfo("discord.postMessage.skipped_missing_config").pipe(
                    Effect.annotateLogs({
                      key: e.key,
                      threadId: room.threadId,
                      roomId: room.id,
                      turnNumber: job.turnNumber,
                    }),
                    Effect.as(null),
                  ),
                ),
                Effect.catchAll((e) =>
                  Effect.logWarning("discord.postMessage.failed").pipe(
                    Effect.annotateLogs({
                      error: errorLabel(e),
                      threadId: room.threadId,
                      roomId: room.id,
                      turnNumber: job.turnNumber,
                    }),
                    Effect.as(null),
                  ),
                ),
              );

              const parsed = posted ? Date.parse(posted.timestamp) : NaN;
              const now = yield* nowMs;
              const createdAtMs = Number.isFinite(parsed) ? parsed : now;
              const discordMessageId = posted
                ? posted.id
                : `local-notification:audience_open:${room.id}:${job.turnNumber}`;

              // Best-effort: store in D1 so notifications are visible in admin UI and filtered out of prompts.
              yield* Effect.tryPromise({
                try: () =>
                  db
                    .insert(messages)
                    .values({
                      roomId: room.id,
                      discordMessageId,
                      threadId: room.threadId,
                      authorType: "notification",
                      authorAgentId: null,
                      authorName: "System",
                      content: notificationContent,
                      createdAtMs,
                    })
                    .onConflictDoNothing({ target: messages.discordMessageId })
                    .run(),
                catch: (cause) => RoomDbError.make({ cause }),
              }).pipe(
                Effect.catchAll((e) =>
                  Effect.logWarning("db.notification_insert.failed").pipe(
                    Effect.annotateLogs({
                      error: String(e),
                      threadId: room.threadId,
                      roomId: room.id,
                      turnNumber: job.turnNumber,
                    }),
                    Effect.asVoid,
                  ),
                ),
              );

              yield* turnEvents.write({
                roomId: room.id,
                turnNumber: job.turnNumber,
                phase: "audience_slot_open",
                status: "ok",
                data: { durationSeconds: audienceSlotSeconds },
              });

              yield* turnEvents.write({
                roomId: room.id,
                turnNumber: job.turnNumber,
                phase: "finish",
                status: "ok",
                data: {
                  nextTurnNumber: job.turnNumber + 1,
                  nextAgentId: next.agentId,
                  audienceSlotOpened: true,
                  audienceSlotDurationSeconds: audienceSlotSeconds,
                },
              });

              return {
                type: "close_audience_slot",
                roomId: room.id,
                turnNumber: job.turnNumber,
                delaySeconds: audienceSlotSeconds,
              } as const;
            }

            // Normal case: advance to the next agent and continue.
            yield* dbTry(() =>
              db
                .update(rooms)
                .set({
                  status: "active",
                  currentTurnNumber: job.turnNumber,
                  currentTurnAgentId: next.agentId,
                })
                .where(eq(rooms.id, room.id))
                .run(),
            );

            yield* turnEvents.write({
              roomId: room.id,
              turnNumber: job.turnNumber,
              phase: "finish",
              status: "ok",
              data: { nextTurnNumber: job.turnNumber + 1, nextAgentId: next.agentId },
            });

            return { type: "turn", roomId: room.id, turnNumber: job.turnNumber + 1 } as const;
          }).pipe(
            Effect.tapError((e) =>
              turnEvents.write({
                roomId: job.roomId,
                turnNumber: job.turnNumber,
                phase: "finish",
                status: "fail",
                data: { error: errorLabel(e), detail: errorDetail(e) },
              }),
            ),
          ),
        ),
      );

      return ArenaService.of({ startArena, createRoom, stopArena, processTurn });
    }),
  );
}
