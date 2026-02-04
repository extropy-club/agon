import { eq } from "drizzle-orm";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import { Db, nowMs } from "../d1/db.js";
import { settings } from "../d1/schema.js";
import { decrypt, encrypt } from "../lib/crypto.js";

export type SettingsKeyStatus = {
  readonly key: string;
  readonly configured: boolean;
  readonly updatedAtMs: number | null;
};

export class Settings extends Context.Tag("@agon/Settings")<
  Settings,
  {
    /**
     * Get a decrypted setting value, with env var fallback.
     */
    readonly getSetting: (key: string) => Effect.Effect<Option.Option<Redacted.Redacted>>;

    /**
     * Encrypt and store a setting.
     */
    readonly setSetting: (key: string, value: string) => Effect.Effect<void, unknown>;

    /**
     * List all keys present in the DB (NOT values).
     */
    readonly listKeys: () => Effect.Effect<ReadonlyArray<SettingsKeyStatus>, unknown>;
  }
>() {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* () {
      const { db } = yield* Db;
      const encryptionKey = yield* Config.redacted("ENCRYPTION_KEY");
      const secret = Redacted.value(encryptionKey);

      const getSetting = Effect.fn("Settings.getSetting")(function* (key: string) {
        const row = yield* Effect.tryPromise({
          try: () => db.select().from(settings).where(eq(settings.key, key)).get(),
          catch: (e) => e,
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.logError("settings.db_get_failed").pipe(
              Effect.annotateLogs({ key, cause: String(cause) }),
              Effect.as(null as { readonly key: string; readonly value: string } | null),
            ),
          ),
        );

        if (row?.value) {
          const decrypted = yield* Effect.tryPromise({
            try: () => decrypt(row.value, secret),
            catch: (e) => e,
          }).pipe(
            Effect.catchAll((cause) =>
              Effect.logError("settings.decrypt_failed").pipe(
                Effect.annotateLogs({ key, cause: String(cause) }),
                Effect.as(null as string | null),
              ),
            ),
          );

          if (decrypted !== null) {
            return Option.some(Redacted.make(decrypted));
          }
        }

        // Backwards compat: fall back to env.
        return yield* Config.option(Config.redacted(key)).pipe(
          Effect.catchAll((cause) =>
            Effect.logError("settings.env_get_failed").pipe(
              Effect.annotateLogs({ key, cause: String(cause) }),
              Effect.as(Option.none<Redacted.Redacted>()),
            ),
          ),
        );
      });

      const setSetting = Effect.fn("Settings.setSetting")(function* (key: string, value: string) {
        const updatedAtMs = yield* nowMs;

        const encrypted = yield* Effect.tryPromise({
          try: () => encrypt(value, secret),
          catch: (e) => e,
        });

        yield* Effect.tryPromise({
          try: () =>
            db
              .insert(settings)
              .values({ key, value: encrypted, updatedAtMs })
              .onConflictDoUpdate({
                target: settings.key,
                set: { value: encrypted, updatedAtMs },
              })
              .run(),
          catch: (e) => e,
        }).pipe(Effect.asVoid);
      });

      const listKeys = Effect.fn("Settings.listKeys")(function* () {
        const rows = yield* Effect.tryPromise({
          try: () =>
            db
              .select({
                key: settings.key,
                updatedAtMs: settings.updatedAtMs,
              })
              .from(settings)
              .all(),
          catch: (e) => e,
        });

        return rows.map((r) => ({ key: r.key, configured: true, updatedAtMs: r.updatedAtMs }));
      });

      return Settings.of({ getSetting, setSetting, listKeys });
    }),
  );
}
