import { Context, Effect, Layer, Schema } from "effect";
import { Db, nowMs } from "../d1/db.js";
import { roomTurnEvents } from "../d1/schema.js";

export type TurnEventPhase =
  | "start"
  | "discord_sync"
  | "llm_start"
  | "llm_ok"
  | "llm_fail"
  | "webhook_post_ok"
  | "webhook_post_fail"
  | "audience_slot_open"
  | "audience_slot_close"
  | "final_failure_notify"
  | "finish";

export type TurnEventStatus = "info" | "ok" | "fail";

export type TurnEventWriteArgs = {
  readonly roomId: number;
  readonly turnNumber: number;
  readonly phase: TurnEventPhase;
  readonly status: TurnEventStatus;
  readonly data?: unknown;
};

export class TurnEventDbError extends Schema.TaggedError<TurnEventDbError>()("TurnEventDbError", {
  cause: Schema.Defect,
}) {}

/**
 * Best-effort persistence of internal turn lifecycle events.
 *
 * Observability MUST NOT break turn processing: failures are logged and swallowed.
 */
export class TurnEventService extends Context.Tag("@agon/TurnEventService")<
  TurnEventService,
  {
    readonly write: (args: TurnEventWriteArgs) => Effect.Effect<void, never>;
  }
>() {
  static readonly layer = Layer.effect(
    TurnEventService,
    Effect.gen(function* () {
      const { db } = yield* Db;

      const write = (args: TurnEventWriteArgs): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          const createdAtMs = yield* nowMs;

          let dataJson: string | null = null;
          if (args.data !== undefined) {
            dataJson = yield* Effect.try(() => JSON.stringify(args.data)).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            );
          }

          yield* Effect.tryPromise({
            try: () =>
              db
                .insert(roomTurnEvents)
                .values({
                  roomId: args.roomId,
                  turnNumber: args.turnNumber,
                  phase: args.phase,
                  status: args.status,
                  createdAtMs,
                  dataJson,
                })
                .run(),
            catch: (cause) => TurnEventDbError.make({ cause }),
          }).pipe(
            Effect.asVoid,
            Effect.catchAll((cause) =>
              Effect.logError("turn_event.write_failed").pipe(
                Effect.annotateLogs({
                  roomId: args.roomId,
                  turnNumber: args.turnNumber,
                  phase: args.phase,
                  status: args.status,
                  cause: String(cause),
                }),
                Effect.asVoid,
              ),
            ),
          );
        });

      return TurnEventService.of({ write });
    }),
  );
}
