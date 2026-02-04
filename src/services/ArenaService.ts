import * as Prompt from "@effect/ai/Prompt";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { Config, Context, Effect, Layer, Schema } from "effect";
import { Db, nowMs } from "../d1/db.js";
import { agents, discordChannels, messages, roomAgents, rooms } from "../d1/schema.js";
import { Discord, DiscordApiError } from "./Discord.js";
import { DiscordWebhookPostFailed, DiscordWebhookPoster } from "./DiscordWebhook.js";
import { type LlmRouterError, LlmRouter } from "./LlmRouter.js";

export type RoomTurnJob = {
  readonly roomId: number;
  readonly turnNumber: number;
};

export class RoomNotFound extends Schema.TaggedError<RoomNotFound>()("RoomNotFound", {
  roomId: Schema.Number,
}) {}

export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()("AgentNotFound", {
  agentId: Schema.String,
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
  | DiscordWebhookPostFailed;

const dbTry = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => RoomDbError.make({ cause }),
  });

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

const rules = (topic: string) =>
  `Debate topic: ${topic}\n\nRules:\n- Stay on topic.\n- No meta talk about being an AI.\n- Aim for 5-10 sentences.\n- If you want to end, say 'Goodbye.'`;

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
    }) => Effect.Effect<{ roomId: number; firstJob: RoomTurnJob }, ArenaError>;

    /**
     * Create (or restart) a room bound to an existing Discord thread.
     */
    readonly createRoom: (args: {
      parentChannelId: string;
      threadId: string;
      topic: string;
      autoArchiveDurationMinutes?: number;
      agentIds?: ReadonlyArray<string>;
    }) => Effect.Effect<{ roomId: number; firstJob: RoomTurnJob }, ArenaError>;

    readonly stopArena: (roomId: number) => Effect.Effect<void, ArenaError>;

    /**
     * Process a single queued turn.
     * Returns the next job to enqueue (or null when the loop terminates).
     */
    readonly processTurn: (job: RoomTurnJob) => Effect.Effect<RoomTurnJob | null, ArenaError>;
  }
>() {
  static readonly layer = Layer.effect(
    ArenaService,
    Effect.gen(function* () {
      const { db } = yield* Db;
      const discord = yield* Discord;
      const llmRouter = yield* LlmRouter;
      const webhookPoster = yield* DiscordWebhookPoster;

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
                parentChannelId: args.parentChannelId,
                threadId: args.threadId,
                autoArchiveDurationMinutes,
                currentTurnAgentId: firstAgentId,
                currentTurnNumber: 0,
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
              parentChannelId: args.parentChannelId,
              threadId: args.threadId,
              autoArchiveDurationMinutes,
              currentTurnAgentId: firstAgentId,
              currentTurnNumber: 0,
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

        return { roomId, firstJob: { roomId, turnNumber: 1 } } as const;
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
      }) {
        return yield* upsertRoom({
          parentChannelId: args.parentChannelId,
          threadId: args.threadId,
          topic: args.topic,
          autoArchiveDurationMinutes: args.autoArchiveDurationMinutes ?? 1440,
          ...(args.agentIds ? { agentIds: args.agentIds } : {}),
        });
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

      const processTurn = Effect.fn("ArenaService.processTurn")(function* (job: RoomTurnJob) {
        const room = yield* dbTry(() =>
          db.select().from(rooms).where(eq(rooms.id, job.roomId)).get(),
        );
        if (!room) return yield* RoomNotFound.make({ roomId: job.roomId });
        if (room.status !== "active") return null;

        // idempotency
        if (room.currentTurnNumber + 1 !== job.turnNumber) return null;

        const agent = yield* dbTry(() =>
          db.select().from(agents).where(eq(agents.id, room.currentTurnAgentId)).get(),
        );
        if (!agent) return yield* AgentNotFound.make({ agentId: room.currentTurnAgentId });

        // webhook info (used for both sync classification and posting)
        const webhook = yield* dbTry(() =>
          db
            .select()
            .from(discordChannels)
            .where(eq(discordChannels.channelId, room.parentChannelId))
            .get(),
        );

        // Sync recent Discord thread history into D1.
        //
        // If DISCORD_BOT_TOKEN is missing, Discord.fetchRecentMessages fails with
        // MissingDiscordConfig — we intentionally skip sync and keep using D1-only history.
        //
        // Any other Discord API failure should fail the turn (and let the queue retry),
        // because Discord is the source of truth for room history.
        const discordMessages = yield* discord
          .fetchRecentMessages(room.threadId, historyLimit)
          .pipe(Effect.catchTag("MissingDiscordConfig", () => Effect.succeed(null)));

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

          for (const { m, createdAtMs } of ordered) {
            const isWebhookMessage = m.webhook_id !== undefined;
            const authorType = isWebhookMessage
              ? ("agent" as const)
              : m.author.bot === true
                ? ("bot_other" as const)
                : ("human" as const);

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
        // bot_other + local-turn duplicates without losing context.
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
          .filter((m) => m.authorType !== "bot_other")
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

        const prompt: Prompt.RawInput = [
          {
            role: "system",
            content: `${agent.systemPrompt}\n\n${rules(room.topic)}`,
          },
          ...promptHistory.map((m) => {
            if (m.authorType === "human") {
              return {
                role: "user",
                content: [Prompt.makePart("text", { text: m.content })],
              } as const;
            }
            return {
              role: "assistant",
              content: [Prompt.makePart("text", { text: m.content })],
            } as const;
          }),
        ];

        // deterministic id to make turn replay idempotent
        const discordMessageId = `local-turn:${room.id}:${job.turnNumber}`;

        const existingReply = yield* dbTry(() =>
          db
            .select({ content: messages.content })
            .from(messages)
            .where(eq(messages.discordMessageId, discordMessageId))
            .get(),
        );

        let reply: string;

        if (existingReply) {
          // queue retry: reuse persisted content and skip LLM call
          reply = existingReply.content;
        } else {
          // thinking delay (basic anti-spam)
          yield* Effect.sleep("3 seconds");

          reply = yield* llmRouter.generate({
            provider: agent.llmProvider,
            model: agent.llmModel,
            prompt,
          });

          const now = yield* nowMs;
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
                    and(eq(messages.createdAtMs, cutoff.createdAtMs), lt(messages.id, cutoff.id)),
                  ),
                ),
              )
              .run();
          });
        }

        // Post to Discord if we have a webhook for this room's parent channel
        if (webhook) {
          yield* webhookPoster.post({
            webhook: { id: webhook.webhookId, token: webhook.webhookToken },
            threadId: room.threadId,
            content: reply,
            username: agent.name,
            ...(agent.avatarUrl ? { avatarUrl: agent.avatarUrl } : {}),
          });
        }

        const shouldStop = reply.toLowerCase().includes("goodbye") || job.turnNumber >= maxTurns;
        if (shouldStop) {
          yield* dbTry(() =>
            db
              .update(rooms)
              .set({ status: "paused", currentTurnNumber: job.turnNumber })
              .where(eq(rooms.id, room.id))
              .run(),
          );
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

        yield* dbTry(() =>
          db
            .update(rooms)
            .set({ currentTurnNumber: job.turnNumber, currentTurnAgentId: next.agentId })
            .where(eq(rooms.id, room.id))
            .run(),
        );

        return { roomId: room.id, turnNumber: job.turnNumber + 1 } as const;
      });

      return ArenaService.of({ startArena, createRoom, stopArena, processTurn });
    }),
  );
}
