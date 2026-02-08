import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep,
  type DefaultProgress,
} from "agents/workflows";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import type * as Prompt from "@effect/ai/Prompt";
import { Config, Effect, Either } from "effect";
import { Db, nowMs } from "../d1/db.js";
import { agents, discordChannels, messages, roomAgents, rooms } from "../d1/schema.js";
import { buildPrompt } from "../lib/promptBuilder.js";
import { retryWithBackoff } from "../lib/retry.js";
import { stepEffect } from "../lib/stepEffect.js";
import { makeRuntime } from "../runtime.js";
import {
  AgentNotFound,
  RoomDbError,
  RoomNotFound,
  dbTry,
  discordRetryAfterMs,
  errorDetail,
  errorLabel,
  isModeratorMessage,
  isRetryableDiscordError,
  isRetryableDiscordWebhookError,
  isRetryableLlmError,
  stripMessageXml,
  turnFailedNotification,
  type RoomTurnJob,
} from "../services/ArenaService.js";
import { Discord } from "../services/Discord.js";
import { DiscordWebhookPoster } from "../services/DiscordWebhook.js";
import { LlmRouter } from "../services/LlmRouter.js";
import { MemoryService } from "../services/MemoryService.js";
import { TurnEventService } from "../services/TurnEventService.js";
import type { Env } from "../index.js";
import { TurnAgent, type TurnParams } from "./TurnAgent.js";

const DB_STEP_CONFIG = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const;

const DISCORD_STEP_CONFIG = {
  retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const LLM_STEP_CONFIG = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "120 minutes",
} as const;

type ExistingReply = {
  readonly content: string;
  readonly createdAtMs: number;
  readonly thinkingText: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

type ContinueCtx = {
  readonly kind: "continue";
  readonly room: typeof rooms.$inferSelect;
  readonly agent: typeof agents.$inferSelect;
  readonly participants: ReadonlyArray<typeof roomAgents.$inferSelect>;
  readonly webhook: { readonly id: string; readonly token: string } | null;
  readonly historyLimit: number;
  readonly existingReply: ExistingReply | null;
  readonly localTurnMessageId: string;
};

type ThinkingResult = {
  readonly thinkingMessageId: string | null;
};

type LlmOkResult = {
  readonly ok: true;
  readonly source: "existing" | "llm";
  readonly reply: string;
  readonly replyCreatedAtMs: number;
  readonly thinkingText: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly isAgentExit: boolean;
  readonly exitSummary: string | null;
};

type LlmFailResult = {
  readonly ok: false;
  readonly error: string;
  readonly detail: Record<string, unknown>;
};

type PersistResult = {
  readonly replyCreatedAtMs: number | null;
};

type AdvanceResult = {
  readonly nextJob: RoomTurnJob | null;
};

const isRetryableDb = (e: unknown): boolean => errorLabel(e) === "RoomDbError";

const isRetryableDiscordOrDb = (e: unknown): boolean =>
  isRetryableDb(e) ||
  (typeof e === "object" && e !== null && "_tag" in e
    ? isRetryableDiscordError(e as never)
    : false);

const isRetryablePostToDiscord = (e: unknown): boolean => {
  const tag = errorLabel(e);
  if (tag === "RoomDbError") return true;
  if (tag === "DiscordWebhookPostFailed") {
    return isRetryableDiscordWebhookError(e as never);
  }
  return false;
};

export class TurnWorkflow extends AgentWorkflow<TurnAgent, TurnParams, DefaultProgress, Env> {
  override async run(
    event: AgentWorkflowEvent<TurnParams>,
    step: AgentWorkflowStep,
  ): Promise<void> {
    const runtime = makeRuntime(this.env);
    const params = event.payload;

    const loadRoom = await stepEffect(
      runtime,
      step,
      "load-room",
      DB_STEP_CONFIG,
      Effect.gen(function* () {
        const { db } = yield* Db;
        const turnEvents = yield* TurnEventService;

        const historyLimit = yield* Config.integer("ARENA_HISTORY_LIMIT").pipe(
          Effect.orElseSucceed(() => 20),
        );

        const room = yield* dbTry(() =>
          db.select().from(rooms).where(eq(rooms.id, params.roomId)).get(),
        );
        if (!room) return yield* RoomNotFound.make({ roomId: params.roomId });

        // Hard stop: manual pause.
        if (room.status === "paused") {
          return { kind: "stop", reason: "paused" } as const;
        }

        // idempotency
        // - normal case: currentTurnNumber + 1 == turnNumber
        // - redelivery: currentTurnNumber == turnNumber
        if (room.currentTurnNumber === params.turnNumber) {
          if (room.status === "audience_slot") {
            const audienceSlotSeconds = Math.max(0, room.audienceSlotDurationSeconds);
            if (audienceSlotSeconds > 0) {
              return {
                kind: "redelivery",
                nextJob: {
                  type: "close_audience_slot",
                  roomId: room.id,
                  turnNumber: params.turnNumber,
                  delaySeconds: audienceSlotSeconds,
                },
              } as const;
            }
          }

          const nextTurnNumber = params.turnNumber + 1;
          if (room.lastEnqueuedTurnNumber >= nextTurnNumber) {
            return { kind: "redelivery", nextJob: null } as const;
          }

          return {
            kind: "redelivery",
            nextJob: { type: "turn", roomId: room.id, turnNumber: nextTurnNumber },
          } as const;
        }

        if (room.currentTurnNumber + 1 !== params.turnNumber) {
          return { kind: "stop", reason: "idempotent_drop" } as const;
        }

        // Audience slot (and other non-active states) intentionally stop the auto-loop.
        if (room.status !== "active") {
          return { kind: "stop", reason: `room_status:${room.status}` } as const;
        }

        const agent = yield* dbTry(() =>
          db.select().from(agents).where(eq(agents.id, room.currentTurnAgentId)).get(),
        );
        if (!agent) return yield* AgentNotFound.make({ agentId: room.currentTurnAgentId });

        const participants = yield* dbTry(() =>
          db
            .select()
            .from(roomAgents)
            .where(eq(roomAgents.roomId, room.id))
            .orderBy(asc(roomAgents.turnOrder))
            .all(),
        );

        const webhookRow = yield* dbTry(() =>
          db
            .select()
            .from(discordChannels)
            .where(eq(discordChannels.channelId, room.parentChannelId))
            .get(),
        );

        const localTurnMessageId = `local-turn:${room.id}:${params.turnNumber}`;

        const existingReply = yield* dbTry(() =>
          db
            .select({
              content: messages.content,
              createdAtMs: messages.createdAtMs,
              thinkingText: messages.thinkingText,
              inputTokens: messages.inputTokens,
              outputTokens: messages.outputTokens,
            })
            .from(messages)
            .where(eq(messages.discordMessageId, localTurnMessageId))
            .get(),
        );

        yield* turnEvents.write({
          roomId: room.id,
          turnNumber: params.turnNumber,
          phase: "start",
          status: "info",
          data: { agentId: agent.id, threadId: room.threadId },
        });

        const ctx: ContinueCtx = {
          kind: "continue",
          room,
          agent,
          participants,
          webhook: webhookRow ? { id: webhookRow.webhookId, token: webhookRow.webhookToken } : null,
          historyLimit,
          existingReply: existingReply
            ? {
                content: existingReply.content,
                createdAtMs: existingReply.createdAtMs,
                thinkingText: existingReply.thinkingText ?? null,
                inputTokens: existingReply.inputTokens ?? null,
                outputTokens: existingReply.outputTokens ?? null,
              }
            : null,
          localTurnMessageId,
        };

        return ctx;
      }),
      isRetryableDb,
    );

    if (loadRoom.kind === "stop") return;

    // Redelivery path: just re-enqueue what we need (if any) and exit.
    if (loadRoom.kind === "redelivery") {
      await this.enqueueNext(step, runtime, params.roomId, loadRoom.nextJob, false);
      return;
    }

    const ctx = loadRoom;

    await stepEffect(
      runtime,
      step,
      "lock-thread",
      DISCORD_STEP_CONFIG,
      Effect.gen(function* () {
        const discord = yield* Discord;

        yield* discord.lockThread(ctx.room.threadId).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("discord.thread.lock.failed").pipe(
              Effect.annotateLogs({
                roomId: ctx.room.id,
                threadId: ctx.room.threadId,
                turnNumber: params.turnNumber,
                error: errorLabel(e),
              }),
              Effect.asVoid,
            ),
          ),
        );

        return true as const;
      }),
      () => false,
    );

    await stepEffect(
      runtime,
      step,
      "discord-sync",
      DISCORD_STEP_CONFIG,
      Effect.gen(function* () {
        const { db } = yield* Db;
        const discord = yield* Discord;
        const turnEvents = yield* TurnEventService;

        const discordMessages = yield* retryWithBackoff(
          discord.fetchRecentMessages(ctx.room.threadId, ctx.historyLimit),
          {
            maxRetries: 3,
            isRetryable: isRetryableDiscordError,
            getRetryAfterMs: discordRetryAfterMs,
          },
        ).pipe(
          Effect.tap((msgs) =>
            turnEvents.write({
              roomId: ctx.room.id,
              turnNumber: params.turnNumber,
              phase: "discord_sync",
              status: "ok",
              data: { fetched: msgs.length },
            }),
          ),
          Effect.catchTag("MissingDiscordConfig", () =>
            turnEvents
              .write({
                roomId: ctx.room.id,
                turnNumber: params.turnNumber,
                phase: "discord_sync",
                status: "info",
                data: { skipped: true },
              })
              .pipe(Effect.as(null)),
          ),
          Effect.tapError((e) =>
            turnEvents.write({
              roomId: ctx.room.id,
              turnNumber: params.turnNumber,
              phase: "discord_sync",
              status: "fail",
              data: { error: errorLabel(e), detail: errorDetail(e) },
            }),
          ),
          Effect.withLogSpan("discord.sync"),
        );

        if (!discordMessages) {
          return { skipped: true, fetched: 0 } as const;
        }

        const agentNameToId = new Map(
          (yield* dbTry(() =>
            db.select({ id: agents.id, name: agents.name }).from(agents).all(),
          )).map((a) => [a.name, a.id] as const),
        );

        const ordered = discordMessages
          .map((m) => ({ m, createdAtMs: Date.parse(m.timestamp) }))
          .filter((x) => Number.isFinite(x.createdAtMs))
          .sort((a, b) => a.createdAtMs - b.createdAtMs);

        const needsBotUserId = ordered.some(({ m }) => m.webhook_id === undefined && m.author.bot);
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
          const authorName = m.author.global_name ?? m.author.username;

          yield* dbTry(() =>
            db
              .insert(messages)
              .values({
                roomId: ctx.room.id,
                discordMessageId: m.id,
                threadId: ctx.room.threadId,
                authorType,
                authorAgentId: authorAgentId ?? null,
                authorName,
                content: m.content,
                createdAtMs,
              })
              .onConflictDoUpdate({
                target: messages.discordMessageId,
                set: {
                  roomId: ctx.room.id,
                  threadId: ctx.room.threadId,
                  authorType,
                  authorAgentId: authorAgentId ?? null,
                  authorName,
                  content: m.content,
                  createdAtMs,
                },
              })
              .run(),
          );
        }

        return { skipped: false, fetched: ordered.length } as const;
      }),
      isRetryableDiscordOrDb,
    );

    const thinking = await stepEffect(
      runtime,
      step,
      "post-thinking",
      DISCORD_STEP_CONFIG,
      Effect.gen(function* () {
        if (ctx.existingReply) {
          const out: ThinkingResult = { thinkingMessageId: null };
          return out;
        }

        const discord = yield* Discord;

        const thinkingMessageId = yield* discord
          .postMessage(ctx.room.threadId, `💭 **${ctx.agent.name}** is thinking…`)
          .pipe(
            Effect.map((m) => m.id),
            Effect.catchAll(() => Effect.succeed(null as string | null)),
          );

        // basic anti-spam delay
        yield* Effect.sleep("3 seconds");

        const out: ThinkingResult = { thinkingMessageId };
        return out;
      }),
      () => false,
    );

    const normalizePromptMessages = (prompt: Prompt.RawInput): Array<Prompt.MessageEncoded> => {
      if (typeof prompt === "string") {
        const msg: Prompt.UserMessageEncoded = {
          role: "user",
          content: [{ type: "text", text: prompt }],
        };
        return [msg];
      }

      const items: Iterable<Prompt.MessageEncoded> =
        (prompt as { content?: ReadonlyArray<Prompt.MessageEncoded> }).content ??
        (prompt as Iterable<Prompt.MessageEncoded>);

      return Array.from(items);
    };

    const makeAssistantToolCallMessage = (args: {
      readonly text: string;
      readonly toolCalls: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly arguments: Record<string, unknown>;
      }>;
    }): Prompt.AssistantMessageEncoded => {
      const text = args.text.trim();

      return {
        role: "assistant",
        content: [
          ...(text.length > 0
            ? ([{ type: "text", text }] satisfies Array<Prompt.TextPartEncoded>)
            : []),
          ...args.toolCalls.map(
            (c) =>
              ({
                type: "tool-call",
                id: c.id,
                name: c.name,
                params: c.arguments,
                providerExecuted: false,
              }) satisfies Prompt.ToolCallPartEncoded,
          ),
        ],
      };
    };

    const makeToolResultsMessage = (
      results: ReadonlyArray<{
        readonly toolCallId: string;
        readonly name: string;
        readonly result: unknown;
      }>,
    ): Prompt.ToolMessageEncoded => ({
      role: "tool",
      content: results.map(
        (r) =>
          ({
            type: "tool-result",
            id: r.toolCallId,
            name: r.name,
            isFailure: false,
            result: r.result,
            providerExecuted: false,
          }) satisfies Prompt.ToolResultPartEncoded,
      ),
    });

    const executeToolCall = (
      toolCall: {
        readonly id: string;
        readonly name: string;
        readonly arguments: Record<string, unknown>;
      },
      agentId: string,
      roomId: number,
    ) =>
      Effect.gen(function* () {
        const memoryService = yield* MemoryService;
        const name = toolCall.name;
        const args = toolCall.arguments;

        switch (name) {
          case "memory_add": {
            const memoriesRaw = args["memories"];
            const memories = Array.isArray(memoriesRaw)
              ? memoriesRaw
                  .map((m) => {
                    if (!m || typeof m !== "object") return null;
                    const content = (m as { content?: unknown }).content;
                    return typeof content === "string" ? { content } : null;
                  })
                  .filter((m): m is { content: string } => m !== null)
              : [];

            return yield* memoryService
              .insertMemories({ agentId, roomId, memories, createdBy: "agent" })
              .pipe(
                Effect.map((r) => ({ ok: true as const, inserted: r.inserted })),
                Effect.catchAll((e) =>
                  Effect.succeed({ ok: false as const, error: errorLabel(e) }),
                ),
              );
          }

          case "memory_search": {
            const query = typeof args["query"] === "string" ? args["query"] : "";
            const limitRaw = args["limit"];
            const limit =
              typeof limitRaw === "number" && Number.isFinite(limitRaw)
                ? Math.max(1, Math.floor(limitRaw))
                : 5;

            return yield* memoryService
              .searchMemories({ agentId, query, limit })
              .pipe(Effect.catchAll((e) => Effect.succeed([{ error: errorLabel(e) }])));
          }

          case "thread_read": {
            const roomIdRaw = args["roomId"];
            const rId =
              typeof roomIdRaw === "number" && Number.isFinite(roomIdRaw)
                ? Math.floor(roomIdRaw)
                : roomId;

            return yield* memoryService
              .getThreadSummary({ roomId: rId })
              .pipe(Effect.catchAll((e) => Effect.succeed({ error: errorLabel(e) })));
          }

          default:
            return { error: `Unknown tool: ${name}` };
        }
      });

    let llmResult: LlmOkResult | LlmFailResult | undefined;

    if (ctx.existingReply) {
      const reply = stripMessageXml(ctx.existingReply.content);
      llmResult = {
        ok: true,
        source: "existing",
        reply,
        replyCreatedAtMs: ctx.existingReply.createdAtMs,
        thinkingText: ctx.existingReply.thinkingText,
        inputTokens: ctx.existingReply.inputTokens,
        outputTokens: ctx.existingReply.outputTokens,
        isAgentExit: false,
        exitSummary: null,
      };
    } else {
      const prompt = await stepEffect(
        runtime,
        step,
        "build-prompt",
        DB_STEP_CONFIG,
        Effect.gen(function* () {
          const { db } = yield* Db;

          // bounded history (timestamp-based due to sync inserts)
          const rawHistoryLimit = Math.max(ctx.historyLimit * 3, 60);
          const rawHistory = yield* dbTry(() =>
            db
              .select()
              .from(messages)
              .where(eq(messages.roomId, ctx.room.id))
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
            .slice(-ctx.historyLimit);

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

          return buildPrompt(
            { title: ctx.room.title, topic: ctx.room.topic },
            { id: ctx.agent.id, name: ctx.agent.name, systemPrompt: ctx.agent.systemPrompt },
            promptHistory.map((m) => ({
              authorType: m.authorType,
              authorName:
                m.authorType === "agent" ? getAgentName(m.authorAgentId) : getNonAgentName(m),
              content: m.content,
            })),
          );
        }),
        isRetryableDb,
      );

      await stepEffect(
        runtime,
        step,
        "llm-start-event",
        DB_STEP_CONFIG,
        Effect.gen(function* () {
          const turnEvents = yield* TurnEventService;
          yield* turnEvents.write({
            roomId: ctx.room.id,
            turnNumber: params.turnNumber,
            phase: "llm_start",
            status: "info",
            data: { llmProvider: ctx.agent.llmProvider, llmModel: ctx.agent.llmModel },
          });
          return true as const;
        }),
        isRetryableDb,
      );

      const conversationMessages = normalizePromptMessages(prompt);

      const MAX_TOOL_ROUNDS = 128;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let finalText = "";
      let lastReasoningText: string | null = null;

      let isAgentExit = false;
      let exitSummary: string | null = null;

      let pendingToolResults:
        | {
            readonly forRouter: ReadonlyArray<{ toolCallId: string; name: string; result: string }>;
            readonly forPrompt: ReadonlyArray<{
              toolCallId: string;
              name: string;
              result: unknown;
            }>;
          }
        | undefined = undefined;

      let roundsUsed = 0;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        roundsUsed = round + 1;

        const llmRound = await stepEffect(
          runtime,
          step,
          `llm-round-${round}`,
          LLM_STEP_CONFIG,
          Effect.gen(function* () {
            const llmRouter = yield* LlmRouter;
            const discord = yield* Discord;
            const turnEvents = yield* TurnEventService;

            const startedAtMs = yield* nowMs;

            const llmEither = yield* retryWithBackoff(
              llmRouter.generate({
                provider: ctx.agent.llmProvider,
                model: ctx.agent.llmModel,
                prompt: conversationMessages,
                ...(ctx.agent.temperature
                  ? { temperature: parseFloat(ctx.agent.temperature) }
                  : {}),
                ...(ctx.agent.maxTokens != null ? { maxTokens: ctx.agent.maxTokens } : {}),
                ...(ctx.agent.thinkingLevel != null
                  ? { thinkingLevel: ctx.agent.thinkingLevel }
                  : {}),
                ...(ctx.agent.thinkingBudgetTokens != null
                  ? { thinkingBudgetTokens: ctx.agent.thinkingBudgetTokens }
                  : {}),
                ...(pendingToolResults ? { toolResults: pendingToolResults.forRouter } : {}),
              }),
              { maxRetries: 3, isRetryable: isRetryableLlmError },
            ).pipe(Effect.withLogSpan("llm.generate"), Effect.either);

            const finishedAtMs = yield* nowMs;
            const latencyMs = Math.max(0, finishedAtMs - startedAtMs);

            if (Either.isLeft(llmEither)) {
              const e = llmEither.left;

              yield* turnEvents.write({
                roomId: ctx.room.id,
                turnNumber: params.turnNumber,
                phase: "llm_fail",
                status: "fail",
                data: { round, error: errorLabel(e), detail: errorDetail(e) },
              });

              // Best-effort: notify room.
              yield* discord.postMessage(ctx.room.threadId, turnFailedNotification).pipe(
                (eff) =>
                  retryWithBackoff(eff, {
                    maxRetries: 3,
                    isRetryable: isRetryableDiscordError,
                    getRetryAfterMs: discordRetryAfterMs,
                  }),
                Effect.tap(() =>
                  turnEvents.write({
                    roomId: ctx.room.id,
                    turnNumber: params.turnNumber,
                    phase: "final_failure_notify",
                    status: "ok",
                    data: { source: "llm", round },
                  }),
                ),
                Effect.catchAll((notifyErr) =>
                  turnEvents
                    .write({
                      roomId: ctx.room.id,
                      turnNumber: params.turnNumber,
                      phase: "final_failure_notify",
                      status: "fail",
                      data: {
                        source: "llm",
                        round,
                        error: errorLabel(notifyErr),
                        originalError: errorLabel(e),
                      },
                    })
                    .pipe(Effect.asVoid),
                ),
                Effect.asVoid,
              );

              return {
                ok: false as const,
                error: errorLabel(e),
                detail: errorDetail(e),
                latencyMs,
              };
            }

            const ok = llmEither.right;

            yield* Effect.logInfo("llm.round.ok").pipe(
              Effect.annotateLogs({
                roomId: ctx.room.id,
                turnNumber: params.turnNumber,
                round,
                latencyMs,
                toolCalls: ok.toolCalls.length,
              }),
            );

            return { ok: true as const, result: ok, latencyMs };
          }),
          isRetryableDb,
        );

        if (!llmRound.ok) {
          llmResult = { ok: false, error: llmRound.error, detail: llmRound.detail };
          break;
        }

        // After the LLM consumed pending tool results, persist them into the conversation history.
        if (pendingToolResults && pendingToolResults.forPrompt.length > 0) {
          conversationMessages.push(makeToolResultsMessage(pendingToolResults.forPrompt));
          pendingToolResults = undefined;
        }

        const ok = llmRound.result;
        lastReasoningText = ok.reasoningText ?? null;

        totalInputTokens += ok.inputTokens ?? 0;
        totalOutputTokens += ok.outputTokens ?? 0;

        if (ok.exitSummary) {
          isAgentExit = true;
          exitSummary = ok.exitSummary;
          finalText = ok.exitSummary;
          break;
        }

        if (ok.toolCalls.length === 0) {
          finalText = ok.text;
          break;
        }

        // Store the tool calls into the conversation (assistant tool-call message).
        conversationMessages.push(
          makeAssistantToolCallMessage({ text: ok.text, toolCalls: ok.toolCalls }),
        );

        const toolResultsForRouter: Array<{ toolCallId: string; name: string; result: string }> =
          [];
        const toolResultsForPrompt: Array<{ toolCallId: string; name: string; result: unknown }> =
          [];

        for (const toolCall of ok.toolCalls) {
          const toolRes = await stepEffect(
            runtime,
            step,
            `tool-${round}-${toolCall.id}`,
            DB_STEP_CONFIG,
            executeToolCall(toolCall, ctx.agent.id, ctx.room.id).pipe(
              Effect.catchAll((e) => Effect.succeed({ error: errorLabel(e) })),
            ),
            isRetryableDb,
          );

          toolResultsForPrompt.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            result: toolRes,
          });

          let encoded = "";
          try {
            encoded = JSON.stringify(toolRes);
          } catch {
            encoded = String(toolRes);
          }
          toolResultsForRouter.push({
            toolCallId: toolCall.id,
            name: toolCall.name,
            result: encoded,
          });
        }

        pendingToolResults = { forRouter: toolResultsForRouter, forPrompt: toolResultsForPrompt };
      }

      if (!llmResult) {
        if (finalText.trim().length === 0) {
          llmResult = {
            ok: false,
            error: "ToolLoopExceeded",
            detail: { rounds: MAX_TOOL_ROUNDS },
          };
        } else {
          const reply = stripMessageXml(exitSummary ?? finalText);

          await stepEffect(
            runtime,
            step,
            "llm-finish-event",
            DB_STEP_CONFIG,
            Effect.gen(function* () {
              const turnEvents = yield* TurnEventService;
              yield* turnEvents.write({
                roomId: ctx.room.id,
                turnNumber: params.turnNumber,
                phase: "llm_ok",
                status: "ok",
                data: {
                  replyChars: reply.length,
                  inputTokens: totalInputTokens,
                  outputTokens: totalOutputTokens,
                  rounds: roundsUsed,
                  ...(isAgentExit ? { agentExit: true, exitSummaryChars: reply.length } : {}),
                },
              });
              return true as const;
            }),
            isRetryableDb,
          );

          const createdAtMs = await stepEffect(
            runtime,
            step,
            "llm-created-at",
            DB_STEP_CONFIG,
            Effect.gen(function* () {
              return yield* nowMs;
            }),
            isRetryableDb,
          );

          llmResult = {
            ok: true,
            source: "llm",
            reply,
            replyCreatedAtMs: createdAtMs,
            thinkingText: lastReasoningText,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            isAgentExit,
            exitSummary,
          };
        }
      }
    }

    // Safety net: should never happen.
    if (!llmResult) {
      llmResult = { ok: false, error: "LlmUnknown", detail: {} };
    }

    const persisted = await stepEffect(
      runtime,
      step,
      "persist-message",
      DB_STEP_CONFIG,
      Effect.gen(function* () {
        const { db } = yield* Db;
        const discord = yield* Discord;

        // Always best-effort cleanup of thinking message.
        if (thinking.thinkingMessageId) {
          yield* discord.deleteMessage(ctx.room.threadId, thinking.thinkingMessageId).pipe(
            (eff) =>
              retryWithBackoff(eff, {
                maxRetries: 2,
                isRetryable: isRetryableDiscordError,
                getRetryAfterMs: discordRetryAfterMs,
              }),
            Effect.catchAll(() => Effect.void),
            Effect.asVoid,
          );
        }

        if (!llmResult.ok) {
          const out: PersistResult = { replyCreatedAtMs: null };
          return out;
        }

        if (!ctx.existingReply) {
          yield* dbTry(() =>
            db
              .insert(messages)
              .values({
                roomId: ctx.room.id,
                discordMessageId: ctx.localTurnMessageId,
                threadId: ctx.room.threadId,
                authorType: "agent",
                authorAgentId: ctx.agent.id,
                content: llmResult.reply,
                thinkingText: llmResult.thinkingText,
                inputTokens: llmResult.inputTokens,
                outputTokens: llmResult.outputTokens,
                createdAtMs: llmResult.replyCreatedAtMs,
              })
              .onConflictDoNothing({ target: messages.discordMessageId })
              .run(),
          );

          // Trim history to avoid unbounded growth
          yield* dbTry(async () => {
            const countRow = await db
              .select({ c: sql<number>`count(*)` })
              .from(messages)
              .where(eq(messages.roomId, ctx.room.id))
              .get();

            const count = countRow ? Number(countRow.c) : 0;
            const maxKeep = Math.max(ctx.historyLimit * 3, 60);
            if (count <= maxKeep) return;

            const cutoff = await db
              .select({ id: messages.id, createdAtMs: messages.createdAtMs })
              .from(messages)
              .where(eq(messages.roomId, ctx.room.id))
              .orderBy(desc(messages.createdAtMs), desc(messages.id))
              .offset(maxKeep)
              .limit(1)
              .get();

            if (!cutoff) return;

            await db
              .delete(messages)
              .where(
                and(
                  eq(messages.roomId, ctx.room.id),
                  or(
                    lt(messages.createdAtMs, cutoff.createdAtMs),
                    and(eq(messages.createdAtMs, cutoff.createdAtMs), lt(messages.id, cutoff.id)),
                  ),
                ),
              )
              .run();
          });
        }

        const row = yield* dbTry(() =>
          db
            .select({ createdAtMs: messages.createdAtMs })
            .from(messages)
            .where(eq(messages.discordMessageId, ctx.localTurnMessageId))
            .get(),
        );

        if (!row) {
          return yield* RoomDbError.make({ cause: new Error("persisted reply missing") });
        }

        const out: PersistResult = { replyCreatedAtMs: row.createdAtMs };
        return out;
      }),
      isRetryableDb,
    );

    await stepEffect(
      runtime,
      step,
      "post-to-discord",
      DISCORD_STEP_CONFIG,
      Effect.gen(function* () {
        const { db } = yield* Db;
        const webhookPoster = yield* DiscordWebhookPoster;
        const discord = yield* Discord;
        const turnEvents = yield* TurnEventService;

        if (!llmResult.ok) return { skipped: true } as const;
        if (!ctx.webhook) return { skipped: true } as const;

        const replyCreatedAtMs = persisted.replyCreatedAtMs ?? llmResult.replyCreatedAtMs;

        // Deduplicate by checking if a webhook message with matching content is already in D1.
        const rawHistoryLimit = Math.max(ctx.historyLimit * 3, 60);
        const rawHistory = yield* dbTry(() =>
          db
            .select()
            .from(messages)
            .where(eq(messages.roomId, ctx.room.id))
            .orderBy(desc(messages.createdAtMs), desc(messages.id))
            .limit(rawHistoryLimit)
            .all(),
        );

        const localTurnDedupeWindowMs = 30 * 60 * 1000;
        const localTurnDedupeAllowEarlyMs = 30 * 1000;

        const alreadyPostedToDiscord = rawHistory.some((m) => {
          if (m.authorType !== "agent") return false;
          if (m.discordMessageId.startsWith("local-turn:")) return false;
          if (m.content !== llmResult.reply) return false;
          const dt = m.createdAtMs - replyCreatedAtMs;
          if (dt < -localTurnDedupeAllowEarlyMs) return false;
          if (dt > localTurnDedupeWindowMs) return false;
          if (m.authorAgentId !== ctx.agent.id) return false;
          return true;
        });

        if (alreadyPostedToDiscord) {
          return { skipped: true } as const;
        }

        const postEither = yield* retryWithBackoff(
          webhookPoster.post({
            webhook: ctx.webhook,
            threadId: ctx.room.threadId,
            content: llmResult.reply,
            username: ctx.agent.name,
            ...(ctx.agent.avatarUrl ? { avatarUrl: ctx.agent.avatarUrl } : {}),
          }),
          { maxRetries: 3, isRetryable: isRetryableDiscordWebhookError },
        ).pipe(Effect.withLogSpan("discord.webhook.post"), Effect.either);

        if (Either.isLeft(postEither)) {
          const e = postEither.left;

          yield* turnEvents.write({
            roomId: ctx.room.id,
            turnNumber: params.turnNumber,
            phase: "webhook_post_fail",
            status: "fail",
            data: { error: errorLabel(e), detail: errorDetail(e) },
          });

          if (!llmResult.isAgentExit) {
            yield* discord.postMessage(ctx.room.threadId, turnFailedNotification).pipe(
              (eff) =>
                retryWithBackoff(eff, {
                  maxRetries: 3,
                  isRetryable: isRetryableDiscordError,
                  getRetryAfterMs: discordRetryAfterMs,
                }),
              Effect.catchAll(() => Effect.void),
              Effect.asVoid,
            );
          }

          return { skipped: false } as const;
        }

        yield* turnEvents.write({
          roomId: ctx.room.id,
          turnNumber: params.turnNumber,
          phase: "webhook_post_ok",
          status: "ok",
        });

        return { skipped: false } as const;
      }),
      isRetryablePostToDiscord,
    );

    const advance = await stepEffect(
      runtime,
      step,
      "advance-turn",
      DB_STEP_CONFIG,
      Effect.gen(function* () {
        const { db } = yield* Db;
        const discord = yield* Discord;
        const turnEvents = yield* TurnEventService;

        const participants = ctx.participants.length
          ? ctx.participants
          : yield* dbTry(() =>
              db
                .select()
                .from(roomAgents)
                .where(eq(roomAgents.roomId, ctx.room.id))
                .orderBy(asc(roomAgents.turnOrder))
                .all(),
            );

        const idx = Math.max(
          0,
          participants.findIndex((p) => p.agentId === ctx.agent.id),
        );
        const next = participants[(idx + 1) % participants.length];

        if (!llmResult.ok) {
          yield* dbTry(() =>
            db
              .update(rooms)
              .set({
                status: "active",
                currentTurnNumber: params.turnNumber,
                currentTurnAgentId: next.agentId,
              })
              .where(eq(rooms.id, ctx.room.id))
              .run(),
          );

          yield* turnEvents.write({
            roomId: ctx.room.id,
            turnNumber: params.turnNumber,
            phase: "finish",
            status: "fail",
            data: {
              error: llmResult.error,
              source: "llm",
              detail: llmResult.detail,
              skippedToNextAgent: true,
              nextTurnNumber: params.turnNumber + 1,
              nextAgentId: next.agentId,
            },
          });

          const out: AdvanceResult = {
            nextJob: { type: "turn", roomId: ctx.room.id, turnNumber: params.turnNumber + 1 },
          };
          return out;
        }

        if (llmResult.isAgentExit) {
          yield* dbTry(() =>
            db
              .update(rooms)
              .set({
                status: "paused",
                currentTurnNumber: params.turnNumber,
                currentTurnAgentId: next.agentId,
              })
              .where(eq(rooms.id, ctx.room.id))
              .run(),
          );

          yield* turnEvents.write({
            roomId: ctx.room.id,
            turnNumber: params.turnNumber,
            phase: "agent_exit",
            status: "ok",
            data: { agentId: ctx.agent.id, summary: llmResult.reply },
          });

          yield* turnEvents.write({
            roomId: ctx.room.id,
            turnNumber: params.turnNumber,
            phase: "finish",
            status: "ok",
            data: {
              stopped: true,
              reason: "agent_exit",
              nextTurnNumber: params.turnNumber + 1,
              nextAgentId: next.agentId,
            },
          });

          const out: AdvanceResult = { nextJob: null };
          return out;
        }

        if (params.turnNumber >= ctx.room.maxTurns) {
          yield* dbTry(() =>
            db
              .update(rooms)
              .set({ status: "paused", currentTurnNumber: params.turnNumber })
              .where(eq(rooms.id, ctx.room.id))
              .run(),
          );

          yield* turnEvents.write({
            roomId: ctx.room.id,
            turnNumber: params.turnNumber,
            phase: "finish",
            status: "ok",
            data: { stopped: true, reason: "max_turns_reached" },
          });

          const out: AdvanceResult = { nextJob: null };
          return out;
        }

        const isEndOfAgentCycle = idx === participants.length - 1;
        const audienceSlotSeconds = Math.max(0, ctx.room.audienceSlotDurationSeconds);
        const shouldOpenAudienceSlot = isEndOfAgentCycle && audienceSlotSeconds > 0;

        if (shouldOpenAudienceSlot) {
          yield* dbTry(() =>
            db
              .update(rooms)
              .set({
                status: "audience_slot",
                currentTurnNumber: params.turnNumber,
                currentTurnAgentId: next.agentId,
              })
              .where(eq(rooms.id, ctx.room.id))
              .run(),
          );

          // Best-effort: unlock thread + post notification.
          yield* retryWithBackoff(discord.unlockThread(ctx.room.threadId), {
            maxRetries: 3,
            isRetryable: isRetryableDiscordError,
            getRetryAfterMs: discordRetryAfterMs,
          }).pipe(Effect.catchAll(() => Effect.void));

          const notificationContent = `💬 Audience slot open (${audienceSlotSeconds}s) - share your thoughts!`;

          const posted = yield* discord.postMessage(ctx.room.threadId, notificationContent).pipe(
            (eff) =>
              retryWithBackoff(eff, {
                maxRetries: 3,
                isRetryable: isRetryableDiscordError,
                getRetryAfterMs: discordRetryAfterMs,
              }),
            Effect.catchTag("MissingDiscordConfig", () => Effect.succeed(null)),
            Effect.catchAll(() => Effect.succeed(null)),
          );

          const parsed = posted ? Date.parse(posted.timestamp) : NaN;
          const now = yield* nowMs;
          const createdAtMs = posted && Number.isFinite(parsed) ? parsed : now;
          const discordMessageId = posted
            ? posted.id
            : `local-notification:audience_open:${ctx.room.id}:${params.turnNumber}`;

          yield* Effect.tryPromise({
            try: () =>
              db
                .insert(messages)
                .values({
                  roomId: ctx.room.id,
                  discordMessageId,
                  threadId: ctx.room.threadId,
                  authorType: "notification",
                  authorAgentId: null,
                  authorName: "System",
                  content: notificationContent,
                  createdAtMs,
                })
                .onConflictDoNothing({ target: messages.discordMessageId })
                .run(),
            catch: (cause) => RoomDbError.make({ cause }),
          }).pipe(Effect.catchAll(() => Effect.void));

          yield* turnEvents.write({
            roomId: ctx.room.id,
            turnNumber: params.turnNumber,
            phase: "audience_slot_open",
            status: "ok",
            data: { durationSeconds: audienceSlotSeconds },
          });

          yield* turnEvents.write({
            roomId: ctx.room.id,
            turnNumber: params.turnNumber,
            phase: "finish",
            status: "ok",
            data: {
              nextTurnNumber: params.turnNumber + 1,
              nextAgentId: next.agentId,
              audienceSlotOpened: true,
              audienceSlotDurationSeconds: audienceSlotSeconds,
            },
          });

          const out: AdvanceResult = {
            nextJob: {
              type: "close_audience_slot",
              roomId: ctx.room.id,
              turnNumber: params.turnNumber,
              delaySeconds: audienceSlotSeconds,
            },
          };
          return out;
        }

        // Normal case: advance to the next agent and continue.
        yield* dbTry(() =>
          db
            .update(rooms)
            .set({
              status: "active",
              currentTurnNumber: params.turnNumber,
              currentTurnAgentId: next.agentId,
            })
            .where(eq(rooms.id, ctx.room.id))
            .run(),
        );

        yield* turnEvents.write({
          roomId: ctx.room.id,
          turnNumber: params.turnNumber,
          phase: "finish",
          status: "ok",
          data: { nextTurnNumber: params.turnNumber + 1, nextAgentId: next.agentId },
        });

        const out: AdvanceResult = {
          nextJob: { type: "turn", roomId: ctx.room.id, turnNumber: params.turnNumber + 1 },
        };
        return out;
      }),
      isRetryableDb,
    );

    await stepEffect(
      runtime,
      step,
      "unlock-thread",
      DISCORD_STEP_CONFIG,
      Effect.gen(function* () {
        const discord = yield* Discord;

        yield* discord.unlockThread(ctx.room.threadId).pipe(
          Effect.catchAll((e) =>
            Effect.logWarning("discord.thread.unlock.failed").pipe(
              Effect.annotateLogs({
                roomId: ctx.room.id,
                threadId: ctx.room.threadId,
                turnNumber: params.turnNumber,
                error: errorLabel(e),
              }),
              Effect.asVoid,
            ),
          ),
        );

        return true as const;
      }),
      () => false,
    );

    const debateEnded =
      llmResult.ok && (llmResult.isAgentExit || params.turnNumber >= ctx.room.maxTurns);

    await this.enqueueNext(step, runtime, ctx.room.id, advance.nextJob, debateEnded);
  }

  private async enqueueNext(
    step: AgentWorkflowStep,
    runtime: ReturnType<typeof makeRuntime>,
    roomId: number,
    nextJob: RoomTurnJob | null,
    debateEnded: boolean,
  ): Promise<void> {
    const env = this.env;

    const job: RoomTurnJob | null =
      nextJob ?? (debateEnded ? ({ type: "finalize_room", roomId } as const) : null);

    if (!job) return;

    await stepEffect(
      runtime,
      step,
      "enqueue-next",
      DB_STEP_CONFIG,
      Effect.gen(function* () {
        const { db } = yield* Db;

        if (job.type === "turn") {
          const room = yield* dbTry(() =>
            db.select().from(rooms).where(eq(rooms.id, roomId)).get(),
          );

          if (!room) return { enqueued: false } as const;
          if (room.lastEnqueuedTurnNumber >= job.turnNumber) {
            return { enqueued: false } as const;
          }

          yield* Effect.tryPromise({
            try: () => env.ARENA_QUEUE.send(job),
            catch: (cause) => RoomDbError.make({ cause }),
          });

          yield* dbTry(() =>
            db
              .update(rooms)
              .set({
                lastEnqueuedTurnNumber: sql`max(${rooms.lastEnqueuedTurnNumber}, ${job.turnNumber})`,
              })
              .where(eq(rooms.id, roomId))
              .run(),
          );

          return { enqueued: true } as const;
        }

        if (job.type === "close_audience_slot") {
          yield* Effect.tryPromise({
            try: () => env.ARENA_QUEUE.send(job, { delaySeconds: job.delaySeconds }),
            catch: (cause) => RoomDbError.make({ cause }),
          });

          return { enqueued: true } as const;
        }

        // finalize_room (and any future immediate jobs)
        yield* Effect.tryPromise({
          try: () => env.ARENA_QUEUE.send(job),
          catch: (cause) => RoomDbError.make({ cause }),
        });

        return { enqueued: true } as const;
      }),
      isRetryableDb,
    );
  }
}
