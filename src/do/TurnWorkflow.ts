import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep,
  type DefaultProgress,
} from "agents/workflows";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { Db } from "../d1/db.js";
import { rooms } from "../d1/schema.js";
import { stepEffect } from "../lib/stepEffect.js";
import { makeRuntime } from "../runtime.js";
import { RoomDbError, RoomNotFound } from "../services/ArenaService.js";
import type { Env } from "../index.js";
import { TurnAgent, type TurnParams } from "./TurnAgent.js";

const DEFAULT_STEP_CONFIG = {
  retries: {
    limit: 5,
    delay: "10 seconds",
    backoff: "exponential",
  },
  timeout: "10 minutes",
} as const;

export class TurnWorkflow extends AgentWorkflow<TurnAgent, TurnParams, DefaultProgress, Env> {
  override async run(
    event: AgentWorkflowEvent<TurnParams>,
    step: AgentWorkflowStep,
  ): Promise<void> {
    const runtime = makeRuntime(this.env);

    const params = event.payload;

    // Skeleton step: load the room from D1 and fail fast if missing.
    await stepEffect(
      runtime,
      step,
      "load-room",
      DEFAULT_STEP_CONFIG,
      Effect.gen(function* () {
        const { db } = yield* Db;

        const room = yield* Effect.tryPromise({
          try: () => db.select().from(rooms).where(eq(rooms.id, params.roomId)).get(),
          catch: (cause) => RoomDbError.make({ cause }),
        });

        if (!room) {
          return yield* RoomNotFound.make({ roomId: params.roomId });
        }

        return room;
      }),
    );
  }
}
