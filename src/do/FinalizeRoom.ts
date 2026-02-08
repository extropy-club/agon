import type * as Prompt from "@effect/ai/Prompt";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect, Option, Redacted, Schema } from "effect";
import { Db, nowMs } from "../d1/db.js";
import { agents, messages, roomAgents, rooms } from "../d1/schema.js";
import { LlmProviderSchema, LlmRouter } from "../services/LlmRouter.js";
import { MemoryService } from "../services/MemoryService.js";
import { Settings } from "../services/Settings.js";

const DEFAULT_PROVIDER = "openrouter" as const;
const DEFAULT_MODEL = "meta-llama/llama-3.1-8b-instruct" as const;

const makePrompt = (args: { readonly system: string; readonly user: string }): Prompt.RawInput =>
  [
    { role: "system", content: args.system },
    { role: "user", content: [{ type: "text", text: args.user }] },
  ] satisfies Array<Prompt.MessageEncoded>;

const stripCodeFences = (raw: string): string => {
  const t = raw.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(t);
  return m ? m[1].trim() : t;
};

const extractJsonArray = (raw: string): unknown => {
  const t = stripCodeFences(raw);

  try {
    return JSON.parse(t) as unknown;
  } catch {
    // Try to salvage when the model included extra prose.
    const start = t.indexOf("[");
    const end = t.lastIndexOf("]");
    if (start >= 0 && end > start) {
      const slice = t.slice(start, end + 1);
      try {
        return JSON.parse(slice) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
};

const MemoryItem = Schema.Struct({ content: Schema.String });

const normalizeMemories = (u: unknown): ReadonlyArray<{ content: string }> => {
  if (!Array.isArray(u)) return [];
  const out: Array<{ content: string }> = [];

  for (const item of u) {
    const decoded = Schema.decodeUnknownEither(MemoryItem)(item);
    if (decoded._tag === "Left") continue;

    const content = decoded.right.content.trim();
    if (content.length === 0) continue;

    out.push({ content });
    if (out.length >= 15) break;
  }

  return out;
};

const roomTranscript = (args: {
  readonly room: { readonly title: string; readonly topic: string };
  readonly agentNameById: ReadonlyMap<string, string>;
  readonly messages: ReadonlyArray<{
    readonly authorType: string;
    readonly authorAgentId: string | null;
    readonly authorName: string | null;
    readonly content: string;
  }>;
}): string => {
  const lines: Array<string> = [];
  lines.push(`Room title: ${args.room.title}`);
  lines.push(`Topic: ${args.room.topic}`);
  lines.push("");

  for (const m of args.messages) {
    if (m.authorType === "notification") continue;

    const author =
      m.authorType === "agent"
        ? m.authorAgentId && args.agentNameById.has(m.authorAgentId)
          ? (args.agentNameById.get(m.authorAgentId) ?? "Agent")
          : (m.authorName ?? "Agent")
        : (m.authorName ??
          (m.authorType === "moderator"
            ? "Moderator"
            : m.authorType === "audience"
              ? "Audience"
              : "System"));

    lines.push(`${author}: ${m.content}`);
  }

  // Keep the end of the transcript when it is too large.
  const joined = lines.join("\n");
  const maxChars = 50_000;
  return joined.length <= maxChars ? joined : `…(truncated)…\n\n${joined.slice(-maxChars)}`;
};

const tryOr = <A>(
  label: string,
  thunk: () => Promise<A>,
  fallback: A,
  annotations: Record<string, unknown> = {},
): Effect.Effect<A> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => cause }).pipe(
    Effect.catchAll((cause) =>
      Effect.logWarning(label).pipe(
        Effect.annotateLogs({ ...annotations, cause: String(cause) }),
        Effect.as(fallback),
      ),
    ),
  );

const readExtractionConfig = Effect.fn("FinalizeRoom.readExtractionConfig")(function* () {
  const settings = yield* Settings;

  const providerRaw = yield* settings
    .getSetting("MEMORY_EXTRACTION_PROVIDER")
    .pipe(
      Effect.map((opt) =>
        Option.match(opt, { onNone: () => DEFAULT_PROVIDER, onSome: Redacted.value }),
      ),
    );

  const model = yield* settings
    .getSetting("MEMORY_EXTRACTION_MODEL")
    .pipe(
      Effect.map((opt) =>
        Option.match(opt, { onNone: () => DEFAULT_MODEL, onSome: Redacted.value }),
      ),
    );

  const providerNormalized = providerRaw.trim();
  const provider = Schema.is(LlmProviderSchema)(providerNormalized)
    ? providerNormalized
    : DEFAULT_PROVIDER;

  return { provider, model: model.trim() || DEFAULT_MODEL } as const;
});

export const finalizeRoom = Effect.fn("FinalizeRoom.finalizeRoom")(function* (args: {
  readonly roomId: number;
}) {
  const { db } = yield* Db;
  const llm = yield* LlmRouter;
  const memory = yield* MemoryService;

  const cfg = yield* readExtractionConfig();

  const room = yield* tryOr(
    "finalize_room.room_load_failed",
    () => db.select().from(rooms).where(eq(rooms.id, args.roomId)).get(),
    null as typeof rooms.$inferSelect | null,
    { roomId: args.roomId },
  );

  if (!room) {
    yield* Effect.logWarning("finalize_room.room_not_found").pipe(
      Effect.annotateLogs({ roomId: args.roomId }),
    );
    return null;
  }

  const participants = yield* tryOr(
    "finalize_room.participants_load_failed",
    () =>
      db
        .select({ agent: agents })
        .from(roomAgents)
        .innerJoin(agents, eq(roomAgents.agentId, agents.id))
        .where(eq(roomAgents.roomId, room.id))
        .orderBy(asc(roomAgents.turnOrder))
        .all(),
    [] as Array<{ agent: typeof agents.$inferSelect }>,
    { roomId: room.id },
  );

  const agentNameById = new Map(participants.map((p) => [p.agent.id, p.agent.name] as const));

  const allMessages = yield* tryOr(
    "finalize_room.messages_load_failed",
    () =>
      db
        .select({
          authorType: messages.authorType,
          authorAgentId: messages.authorAgentId,
          authorName: messages.authorName,
          content: messages.content,
        })
        .from(messages)
        .where(eq(messages.roomId, room.id))
        .orderBy(asc(messages.createdAtMs), asc(messages.id))
        .all(),
    [] as Array<{
      authorType: string;
      authorAgentId: string | null;
      authorName: string | null;
      content: string;
    }>,
    { roomId: room.id },
  );

  const transcript = roomTranscript({
    room: { title: room.title, topic: room.topic },
    agentNameById,
    messages: allMessages,
  });

  // 1) Summary (idempotent)
  if (room.summaryMd === null) {
    const summaryEff = Effect.gen(function* () {
      const r = yield* llm.generate({
        provider: cfg.provider,
        model: cfg.model,
        prompt: makePrompt({
          system:
            "Summarize this debate. Include key arguments, conclusions, and open questions. Return markdown.",
          user: transcript,
        }),
      });

      const summaryMd = r.text.trim();
      if (summaryMd.length === 0) return false as const;

      const updatedAtMs = yield* nowMs;

      const result = yield* tryOr(
        "finalize_room.summary_update_failed",
        () =>
          db
            .update(rooms)
            .set({ summaryMd, summaryUpdatedAtMs: updatedAtMs })
            .where(and(eq(rooms.id, room.id), sql`${rooms.summaryMd} IS NULL`))
            .run(),
        { changes: 0 } as unknown,
        { roomId: room.id },
      );

      const updated =
        typeof (result as { readonly changes?: unknown }).changes === "number"
          ? (result as { readonly changes: number }).changes
          : 0;

      yield* Effect.logInfo("finalize_room.summary_generated").pipe(
        Effect.annotateLogs({ roomId: room.id, updated }),
      );

      return true as const;
    }).pipe(
      Effect.catchAll((e) =>
        Effect.logWarning("finalize_room.summary_failed").pipe(
          Effect.annotateLogs({ roomId: room.id, error: String(e) }),
          Effect.as(false as const),
        ),
      ),
    );

    yield* summaryEff;
  }

  const summaryNow = yield* tryOr(
    "finalize_room.summary_reload_failed",
    () => db.select({ summaryMd: rooms.summaryMd }).from(rooms).where(eq(rooms.id, room.id)).get(),
    null as { summaryMd: string | null } | null,
    { roomId: room.id },
  ).pipe(Effect.map((r) => r?.summaryMd ?? null));

  // 2) Per-agent memory extraction (best-effort)
  for (const p of participants) {
    const agent = p.agent;

    const agentMsgs = allMessages
      .filter((m) => m.authorType === "agent" && m.authorAgentId === agent.id)
      .map((m) => m.content)
      .join("\n\n");

    const user = [
      `Room title: ${room.title}`,
      `Topic: ${room.topic}`,
      summaryNow ? `\nRoom summary:\n${summaryNow}` : "",
      "\nAgent messages:\n" + (agentMsgs.trim().length > 0 ? agentMsgs : "(none)"),
    ]
      .filter((x) => x.trim().length > 0)
      .join("\n");

    const maxChars = 25_000;
    const userTrimmed = user.length <= maxChars ? user : user.slice(-maxChars);

    const extractEff = Effect.gen(function* () {
      const r = yield* llm.generate({
        provider: cfg.provider,
        model: cfg.model,
        prompt: makePrompt({
          system: `Extract atomic knowledge facts from this debate from the perspective of ${agent.name}. Only topic knowledge — no social observations. Return JSON array: [{"content": "fact"}]. Max 15 items.`,
          user: userTrimmed,
        }),
      });

      const parsed = extractJsonArray(r.text);
      const memories = normalizeMemories(parsed);

      if (memories.length === 0) {
        return { inserted: 0 } as const;
      }

      return yield* memory.insertMemories({
        agentId: agent.id,
        roomId: room.id,
        memories,
        createdBy: "auto",
      });
    }).pipe(
      Effect.catchAll((e) =>
        Effect.logWarning("finalize_room.memory_extraction_failed").pipe(
          Effect.annotateLogs({ roomId: room.id, agentId: agent.id, error: String(e) }),
          Effect.as({ inserted: 0 } as const),
        ),
      ),
    );

    const inserted = yield* extractEff;

    yield* Effect.logInfo("finalize_room.memories_inserted").pipe(
      Effect.annotateLogs({ roomId: room.id, agentId: agent.id, inserted: inserted.inserted }),
    );
  }

  return null;
});
