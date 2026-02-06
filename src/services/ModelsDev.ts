import { Context, Effect, Layer, Schema } from "effect";

export type ModelInfo = {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
};

export class ModelsDevError extends Schema.TaggedError<ModelsDevError>()("ModelsDevError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

export class ModelsDev extends Context.Tag("@agon/ModelsDev")<
  ModelsDev,
  {
    /**
     * Fetch all available models from models.dev API.
     * Cached for 1 hour.
     */
    readonly fetchModels: () => Effect.Effect<ReadonlyArray<ModelInfo>, ModelsDevError>;

    /**
     * Get models filtered by provider.
     */
    readonly getModelsByProvider: (
      provider: string,
    ) => Effect.Effect<ReadonlyArray<ModelInfo>, ModelsDevError>;
  }
>() {
  static readonly layer = Layer.effect(
    ModelsDev,
    Effect.gen(function* () {
      const MODELS_DEV_API = "https://models.dev/api.json";
      const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

      let cachedModels: ReadonlyArray<ModelInfo> | null = null;
      let cacheTimestamp: number = 0;

      const fetchModels = Effect.fn("ModelsDev.fetchModels")(function* () {
        const now = Date.now();

        // Return cached data if still valid
        if (cachedModels !== null && now - cacheTimestamp < CACHE_DURATION_MS) {
          return cachedModels;
        }

        // Fetch fresh data
        const response = yield* Effect.tryPromise({
          try: () => fetch(MODELS_DEV_API),
          catch: (cause) => ModelsDevError.make({ operation: "fetch", cause }),
        });

        if (!response.ok) {
          return yield* Effect.fail(
            ModelsDevError.make({
              operation: "fetch",
              cause: new Error(`HTTP ${response.status}: ${response.statusText}`),
            }),
          );
        }

        const data = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (cause) => ModelsDevError.make({ operation: "parse", cause }),
        });

        // Parse the models.dev response format
        // Expected format: { models: [{ id, name, provider }, ...] }
        const parsed: ReadonlyArray<ModelInfo> = yield* Effect.try({
          try: () => {
            if (typeof data !== "object" || data === null || !("models" in data)) {
              throw new Error("Invalid response format: missing 'models' array");
            }
            const models = (data as Record<string, unknown>).models;
            if (!Array.isArray(models)) {
              throw new Error("Invalid response format: 'models' is not an array");
            }
            const validModels: ModelInfo[] = [];
            for (const m of models) {
              if (
                typeof m === "object" &&
                m !== null &&
                typeof (m as Record<string, unknown>).id === "string" &&
                typeof (m as Record<string, unknown>).name === "string" &&
                typeof (m as Record<string, unknown>).provider === "string"
              ) {
                const model = m as Record<string, string>;
                validModels.push({
                  id: model.id,
                  name: model.name,
                  provider: model.provider.toLowerCase(),
                });
              }
            }
            return validModels;
          },
          catch: (cause) => ModelsDevError.make({ operation: "parse", cause }),
        });

        cachedModels = parsed;
        cacheTimestamp = now;

        return parsed;
      });

      const getModelsByProvider = (provider: string) =>
        fetchModels().pipe(
          Effect.map((models) => models.filter((m) => m.provider === provider.toLowerCase())),
        );

      return { fetchModels, getModelsByProvider };
    }),
  );
}
