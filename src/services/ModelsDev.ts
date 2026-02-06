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

      // Fallback models when API is unavailable
      const fallbackModels: ReadonlyArray<ModelInfo> = [
        // OpenAI
        { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
        { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
        { id: "gpt-4-turbo", name: "GPT-4 Turbo", provider: "openai" },
        { id: "gpt-4", name: "GPT-4", provider: "openai" },
        { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", provider: "openai" },
        // Anthropic
        { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", provider: "anthropic" },
        { id: "claude-3-opus-20240229", name: "Claude 3 Opus", provider: "anthropic" },
        { id: "claude-3-sonnet-20240229", name: "Claude 3 Sonnet", provider: "anthropic" },
        { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", provider: "anthropic" },
        // Gemini
        { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", provider: "gemini" },
        { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", provider: "gemini" },
        { id: "gemini-pro", name: "Gemini Pro", provider: "gemini" },
        // OpenRouter
        { id: "openai/gpt-4o-mini", name: "OpenAI GPT-4o Mini (OR)", provider: "openrouter" },
        { id: "openai/gpt-4o", name: "OpenAI GPT-4o (OR)", provider: "openrouter" },
        { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet (OR)", provider: "openrouter" },
        { id: "google/gemini-1.5-flash", name: "Gemini 1.5 Flash (OR)", provider: "openrouter" },
        { id: "meta-llama/llama-3.1-70b-instruct", name: "Llama 3.1 70B (OR)", provider: "openrouter" },
      ];

      const fetchModels = Effect.fn("ModelsDev.fetchModels")(function* () {
        const now = Date.now();

        // Return cached data if still valid
        if (cachedModels !== null && now - cacheTimestamp < CACHE_DURATION_MS) {
          return cachedModels;
        }

        // Try to fetch from API, fallback to defaults on error
        const apiModels = yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(MODELS_DEV_API);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const data = (await response.json()) as unknown;
            
            // Parse the models.dev response format
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
          catch: (e) => ModelsDevError.make({ operation: "fetch", cause: e }),
        }).pipe(Effect.orElse(() => Effect.succeed(fallbackModels)));

        cachedModels = apiModels;
        cacheTimestamp = now;

        return apiModels;
      });

      const getModelsByProvider = (provider: string) =>
        fetchModels().pipe(
          Effect.map((models) => models.filter((m) => m.provider === provider.toLowerCase())),
        );

      return { fetchModels, getModelsByProvider };
    }),
  );
}
