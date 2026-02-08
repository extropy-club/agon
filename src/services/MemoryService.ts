import { and, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { Db, nowMs } from "../d1/db.js";
import { memories, rooms } from "../d1/schema.js";

export class MemoryDbError extends Schema.TaggedError<MemoryDbError>()("MemoryDbError", {
  cause: Schema.Defect,
}) {}

const dbTry = <A>(thunk: () => Promise<A>): Effect.Effect<A, MemoryDbError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => MemoryDbError.make({ cause }),
  });

const sanitizeFtsQuery = (raw: string): string => {
  // Extract word tokens (unicode-aware)
  const tokens = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
  // Cap at 8 terms, add prefix match
  return tokens
    .slice(0, 8)
    .map((t) => `"${t}"*`)
    .join(" ");
};

export class MemoryService extends Context.Tag("@agon/MemoryService")<
  MemoryService,
  {
    readonly insertMemories: (args: {
      agentId: string;
      roomId: number;
      memories: ReadonlyArray<{ content: string }>;
      createdBy?: "agent" | "auto";
    }) => Effect.Effect<{ inserted: number }, MemoryDbError>;

    readonly searchMemories: (args: {
      agentId: string;
      query: string;
      limit?: number;
    }) => Effect.Effect<
      Array<{
        id: string;
        content: string;
        roomId: number;
        createdAtMs: number;
        score: number;
      }>,
      MemoryDbError
    >;

    readonly getThreadSummary: (args: { roomId: number }) => Effect.Effect<
      {
        title: string;
        topic: string;
        summary: string | null;
        status: string;
      } | null,
      MemoryDbError
    >;

    readonly getMemoryById: (args: { id: string; agentId: string }) => Effect.Effect<
      {
        id: string;
        content: string;
        roomId: number;
        createdBy: string;
        createdAtMs: number;
      } | null,
      MemoryDbError
    >;
  }
>() {
  static readonly layer = Layer.effect(
    MemoryService,
    Effect.gen(function* () {
      const { db } = yield* Db;

      const insertMemories = Effect.fn("MemoryService.insertMemories")(function* (args: {
        agentId: string;
        roomId: number;
        memories: ReadonlyArray<{ content: string }>;
        createdBy?: "agent" | "auto";
      }) {
        if (args.memories.length === 0) return { inserted: 0 } as const;

        const createdBy = args.createdBy ?? "agent";
        let inserted = 0;

        // NOTE: D1 / SQLite doesn't have great multi-row VALUES support via Drizzle.
        // Insert sequentially.
        for (const m of args.memories) {
          const id = crypto.randomUUID();
          const createdAtMs = yield* nowMs;

          yield* dbTry(() =>
            db
              .insert(memories)
              .values({
                id,
                agentId: args.agentId,
                roomId: args.roomId,
                content: m.content,
                createdBy,
                createdAtMs,
              })
              .run(),
          );

          inserted += 1;
        }

        return { inserted } as const;
      });

      const searchMemories = Effect.fn("MemoryService.searchMemories")(function* (args: {
        agentId: string;
        query: string;
        limit?: number;
      }) {
        const sanitized = sanitizeFtsQuery(args.query);
        if (sanitized.length === 0) return [];

        const limit = args.limit ?? 8;

        const rows = yield* dbTry(() =>
          db.all<{
            id: string;
            content: string;
            roomId: number;
            createdAtMs: number;
            score: number;
          }>(sql`
            SELECT m.id as id,
                   m.content as content,
                   m.room_id as roomId,
                   m.created_at_ms as createdAtMs,
                   bm25(memories_fts) as score
            FROM memories_fts
            JOIN memories m ON m.rowid = memories_fts.rowid
            WHERE memories_fts MATCH ${sanitized}
              AND m.agent_id = ${args.agentId}
            ORDER BY score
            LIMIT ${limit}
          `),
        );

        return rows.map((r) => ({
          id: String(r.id),
          content: String(r.content),
          roomId: Number(r.roomId),
          createdAtMs: Number(r.createdAtMs),
          score: Number(r.score),
        }));
      });

      const getThreadSummary = Effect.fn("MemoryService.getThreadSummary")(function* (args: {
        roomId: number;
      }) {
        const row = yield* dbTry(() =>
          db
            .select({
              title: rooms.title,
              topic: rooms.topic,
              summaryMd: rooms.summaryMd,
              status: rooms.status,
            })
            .from(rooms)
            .where(eq(rooms.id, args.roomId))
            .get(),
        );

        if (!row) return null;

        return {
          title: row.title,
          topic: row.topic,
          summary: row.summaryMd ?? null,
          status: row.status,
        } as const;
      });

      const getMemoryById = Effect.fn("MemoryService.getMemoryById")(function* (args: {
        id: string;
        agentId: string;
      }) {
        const row = yield* dbTry(() =>
          db
            .select({
              id: memories.id,
              content: memories.content,
              roomId: memories.roomId,
              createdBy: memories.createdBy,
              createdAtMs: memories.createdAtMs,
            })
            .from(memories)
            .where(and(eq(memories.id, args.id), eq(memories.agentId, args.agentId)))
            .get(),
        );

        if (!row) return null;

        return {
          id: row.id,
          content: row.content,
          roomId: row.roomId,
          createdBy: row.createdBy,
          createdAtMs: row.createdAtMs,
        } as const;
      });

      return MemoryService.of({ insertMemories, searchMemories, getThreadSummary, getMemoryById });
    }),
  );
}
