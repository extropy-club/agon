import * as LanguageModel from "@effect/ai/LanguageModel";
import type * as Prompt from "@effect/ai/Prompt";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Config, Context, Effect, Layer, Redacted, Schedule, Schema } from "effect";

// NOTE: "gemini" is accepted as an alias for "google".
export const LlmProviderSchema = Schema.Literal("openai", "anthropic", "google", "gemini");
export type LlmProvider = typeof LlmProviderSchema.Type;

export class InvalidLlmProvider extends Schema.TaggedError<InvalidLlmProvider>()(
  "InvalidLlmProvider",
  {
    value: Schema.String,
  },
) {}

export class MissingLlmApiKey extends Schema.TaggedError<MissingLlmApiKey>()("MissingLlmApiKey", {
  provider: LlmProviderSchema,
  envVar: Schema.String,
}) {}

export class LlmCallFailed extends Schema.TaggedError<LlmCallFailed>()("LlmCallFailed", {
  provider: LlmProviderSchema,
  cause: Schema.Defect,
}) {}

export type LlmError = InvalidLlmProvider | MissingLlmApiKey | LlmCallFailed;

export class LlmConfig extends Context.Tag("@agon/LlmConfig")<
  LlmConfig,
  {
    readonly provider: LlmProvider;
    readonly model: string;
  }
>() {
  static readonly layer = Layer.effect(
    LlmConfig,
    Effect.gen(function* () {
      const providerRaw = yield* Config.string("LLM_PROVIDER").pipe(
        Config.orElse(() => Config.succeed("openai")),
      );

      const provider = yield* Schema.decodeUnknown(LlmProviderSchema)(providerRaw).pipe(
        Effect.mapError(() => InvalidLlmProvider.make({ value: providerRaw })),
      );

      const defaultModel = (p: LlmProvider) => {
        switch (p) {
          case "openai":
            return "gpt-4o-mini";
          case "anthropic":
            return "claude-3-5-sonnet-latest";
          case "google":
          case "gemini":
            return "gemini-1.5-flash";
        }
      };

      const model = yield* Config.string("LLM_MODEL").pipe(
        Config.orElse(() => Config.succeed(defaultModel(provider))),
      );

      return LlmConfig.of({ provider, model });
    }),
  );
}

const requireApiKey = (provider: LlmProvider) => {
  switch (provider) {
    case "openai":
      return Config.redacted("OPENAI_API_KEY").pipe(
        Effect.mapError(() => MissingLlmApiKey.make({ provider, envVar: "OPENAI_API_KEY" })),
      );
    case "anthropic":
      return Config.redacted("ANTHROPIC_API_KEY").pipe(
        Effect.mapError(() => MissingLlmApiKey.make({ provider, envVar: "ANTHROPIC_API_KEY" })),
      );
    case "google":
    case "gemini":
      return Config.redacted("GOOGLE_AI_API_KEY").pipe(
        Effect.mapError(() => MissingLlmApiKey.make({ provider, envVar: "GOOGLE_AI_API_KEY" })),
      );
  }
};

/**
 * Provides `LanguageModel` using one of:
 * - OpenAI (`@effect/ai-openai`)
 * - Anthropic (`@effect/ai-anthropic`)
 * - Google Gemini (`@effect/ai-google`)
 */
export const LanguageModelLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const cfg = yield* LlmConfig;
    const apiKey = yield* requireApiKey(cfg.provider);

    switch (cfg.provider) {
      case "openai":
        return OpenAiLanguageModel.layer({ model: cfg.model }).pipe(
          Layer.provide(OpenAiClient.layer({ apiKey: apiKey as Redacted.Redacted })),
        );

      case "anthropic":
        return AnthropicLanguageModel.layer({ model: cfg.model }).pipe(
          Layer.provide(AnthropicClient.layer({ apiKey: apiKey as Redacted.Redacted })),
        );

      case "google":
      case "gemini":
        return GoogleLanguageModel.layer({ model: cfg.model }).pipe(
          Layer.provide(GoogleClient.layer({ apiKey: apiKey as Redacted.Redacted })),
        );
    }
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

export class Llm extends Context.Tag("@agon/Llm")<
  Llm,
  {
    readonly generate: (prompt: Prompt.RawInput) => Effect.Effect<string, LlmError>;
  }
>() {
  static readonly layer = Layer.effect(
    Llm,
    Effect.gen(function* () {
      const cfg = yield* LlmConfig;
      const lm = yield* LanguageModel.LanguageModel;

      const retryPolicy = Schedule.exponential("200 millis").pipe(
        Schedule.jittered,
        Schedule.intersect(Schedule.recurs(2)),
      );

      const generate = (prompt: Prompt.RawInput) =>
        lm.generateText({ prompt }).pipe(
          Effect.map((r) => r.text.trim()),
          Effect.timeout("30 seconds"),
          Effect.retry(retryPolicy),
          Effect.mapError((cause) => LlmCallFailed.make({ provider: cfg.provider, cause })),
        );

      return Llm.of({ generate });
    }),
  );
}

/**
 * Single layer you want at the app boundary.
 *
 * Provides:
 * - LlmConfig (provider + model)
 * - LanguageModel (selected provider)
 * - Llm (generateText wrapper with timeout/retry)
 */
const llmConfigLayer = LlmConfig.layer;

const languageModelLayer = LanguageModelLive.pipe(Layer.provide(llmConfigLayer));

export const LlmLive = Llm.layer.pipe(
  Layer.provideMerge(languageModelLayer),
  Layer.provideMerge(llmConfigLayer),
);
