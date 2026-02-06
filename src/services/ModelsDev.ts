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

/**
 * Provider ID mapping: our internal names → models.dev API keys.
 *
 * OpenRouter is not on models.dev — we synthesise entries from the other
 * three providers with the `<provider>/<model>` naming convention.
 */
const PROVIDER_MAP: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
};

/** Filter out embedding / audio-only models — keep only text-capable chat models. */
const isChatModel = (m: Record<string, unknown>): boolean => {
  const mods = m.modalities as { input?: string[]; output?: string[] } | undefined;
  if (!mods) return true; // If no modalities info, include it
  const inp = mods.input ?? [];
  const out = mods.output ?? [];
  return inp.includes("text") && out.includes("text");
};

// Fallback models when API is unreachable
const FALLBACK_MODELS: ReadonlyArray<ModelInfo> = [
  // OpenAI
  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 mini", provider: "openai" },
  { id: "gpt-4.1-nano", name: "GPT-4.1 nano", provider: "openai" },
  { id: "o3-mini", name: "o3 Mini", provider: "openai" },
  { id: "gpt-4o-mini", name: "GPT-4o mini", provider: "openai" },
  // Anthropic
  { id: "claude-opus-4-0", name: "Claude Opus 4", provider: "anthropic" },
  { id: "claude-sonnet-4-0", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-3-7-sonnet-latest", name: "Claude Sonnet 3.7", provider: "anthropic" },
  { id: "claude-3-5-haiku-latest", name: "Claude Haiku 3.5", provider: "anthropic" },
  // Gemini
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "gemini" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "gemini" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", provider: "gemini" },
  // OpenRouter (synthesised)
  { id: "openai/gpt-4.1-mini", name: "GPT-4.1 mini (OR)", provider: "openrouter" },
  { id: "anthropic/claude-sonnet-4-0", name: "Claude Sonnet 4 (OR)", provider: "openrouter" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (OR)", provider: "openrouter" },
];

export class ModelsDev extends Context.Tag("@agon/ModelsDev")<
  ModelsDev,
  {
    readonly fetchModels: () => Effect.Effect<ReadonlyArray<ModelInfo>, ModelsDevError>;
    readonly getModelsByProvider: (
      provider: string,
    ) => Effect.Effect<ReadonlyArray<ModelInfo>, ModelsDevError>;
  }
>() {
  static readonly layer = Layer.succeed(
    ModelsDev,
    (() => {
      const MODELS_DEV_API = "https://models.dev/api.json";
      const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

      let cachedModels: ReadonlyArray<ModelInfo> | null = null;
      let cacheTimestamp: number = 0;

      const fetchModels = Effect.fn("ModelsDev.fetchModels")(function* () {
        const now = Date.now();

        if (cachedModels !== null && now - cacheTimestamp < CACHE_DURATION_MS) {
          return cachedModels;
        }

        const apiModels = yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(MODELS_DEV_API);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const data = (await response.json()) as unknown;

            if (typeof data !== "object" || data === null) {
              throw new Error("Invalid response: expected object");
            }

            const providers = data as Record<string, unknown>;
            const result: ModelInfo[] = [];

            // Parse each provider we care about
            for (const [ourProvider, apiKey] of Object.entries(PROVIDER_MAP)) {
              const providerData = providers[apiKey];
              if (typeof providerData !== "object" || providerData === null) continue;

              const modelsObj = (providerData as Record<string, unknown>).models;
              if (typeof modelsObj !== "object" || modelsObj === null) continue;

              for (const [modelId, modelData] of Object.entries(
                modelsObj as Record<string, unknown>,
              )) {
                if (typeof modelData !== "object" || modelData === null) continue;
                const m = modelData as Record<string, unknown>;

                // Skip non-chat models (embeddings, audio-only, etc.)
                if (!isChatModel(m)) continue;

                const name = typeof m.name === "string" ? m.name : modelId;
                result.push({ id: modelId, name, provider: ourProvider });
              }
            }

            // Synthesise OpenRouter entries from the other providers
            for (const [_ourProvider, apiKey] of Object.entries(PROVIDER_MAP)) {
              const providerData = providers[apiKey];
              if (typeof providerData !== "object" || providerData === null) continue;

              const modelsObj = (providerData as Record<string, unknown>).models;
              if (typeof modelsObj !== "object" || modelsObj === null) continue;

              for (const [modelId, modelData] of Object.entries(
                modelsObj as Record<string, unknown>,
              )) {
                if (typeof modelData !== "object" || modelData === null) continue;
                const m = modelData as Record<string, unknown>;
                if (!isChatModel(m)) continue;

                const name = typeof m.name === "string" ? m.name : modelId;
                result.push({
                  id: `${apiKey}/${modelId}`,
                  name: `${name} (OR)`,
                  provider: "openrouter",
                });
              }
            }

            return result;
          },
          catch: (e) => ModelsDevError.make({ operation: "fetch", cause: e }),
        }).pipe(Effect.orElse(() => Effect.succeed(FALLBACK_MODELS)));

        cachedModels = apiModels;
        cacheTimestamp = now;

        return apiModels;
      });

      const getModelsByProvider = (provider: string) =>
        fetchModels().pipe(
          Effect.map((models) => models.filter((m) => m.provider === provider.toLowerCase())),
        );

      return { fetchModels, getModelsByProvider };
    })(),
  );
}
