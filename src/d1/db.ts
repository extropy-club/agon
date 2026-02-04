import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { Context, Effect, Layer } from "effect";

export type D1 = D1Database;

export class Db extends Context.Tag("@agon/Db")<
  Db,
  {
    readonly db: DrizzleD1Database;
  }
>() {
  static layer = (d1: D1) => Layer.succeed(Db, Db.of({ db: drizzle(d1) }));
}

export const nowMs = Effect.sync(() => Date.now());
