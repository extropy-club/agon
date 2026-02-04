import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Model from "@effect/ai/Model";
import type * as Prompt from "@effect/ai/Prompt";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Config, Context, Effect, Layer, Option, Redacted, Schedule, Schema } from "effect";

export const LlmProviderSchema = Schema.Literal("openai", "anthropic", "gemini");
export type LlmProvider = typeof LlmProviderSchema.Type;

export class MissingLlmApiKey extends Schema.TaggedError<MissingLlmApiKey>()("MissingLlmApiKey", {
  provider: LlmProviderSchema,
  envVar: Schema.String,
}) {}

export class LlmCallFailed extends Schema.TaggedError<LlmCallFailed>()("LlmCallFailed", {
  provider: LlmProviderSchema,
  cause: Schema.Defect,
}) {}

export type LlmRouterError = MissingLlmApiKey | LlmCallFailed;

export class LlmRouter extends Context.Tag("@agon/LlmRouter")<
  LlmRouter,
  {
    readonly generate: (args: {
      readonly provider: LlmProvider;
      readonly model: string;
      readonly prompt: Prompt.RawInput;
    }) => Effect.Effect<string, LlmRouterError>;
  }
>() {
  static readonly layer = Layer.effect(
    LlmRouter,
    Effect.gen(function* () {
      // NOTE: we read API keys as optional so the app can boot even when only one provider is used.
      const openAiApiKey = yield* Config.option(Config.redacted("OPENAI_API_KEY"));
      const anthropicApiKey = yield* Config.option(Config.redacted("ANTHROPIC_API_KEY"));
      const googleApiKey = yield* Config.option(Config.redacted("GOOGLE_AI_API_KEY"));

      const retryPolicy = Schedule.exponential("200 millis").pipe(
        Schedule.jittered,
        Schedule.intersect(Schedule.recurs(2)),
      );

      const requireApiKey = (provider: LlmProvider) => {
        switch (provider) {
          case "openai":
            return Option.isNone(openAiApiKey)
              ? Effect.fail(MissingLlmApiKey.make({ provider, envVar: "OPENAI_API_KEY" }))
              : Effect.succeed(openAiApiKey.value);

          case "anthropic":
            return Option.isNone(anthropicApiKey)
              ? Effect.fail(MissingLlmApiKey.make({ provider, envVar: "ANTHROPIC_API_KEY" }))
              : Effect.succeed(anthropicApiKey.value);

          case "gemini":
            return Option.isNone(googleApiKey)
              ? Effect.fail(MissingLlmApiKey.make({ provider, envVar: "GOOGLE_AI_API_KEY" }))
              : Effect.succeed(googleApiKey.value);
        }
      };

      const makeLanguageModelLayer = (
        provider: LlmProvider,
        model: string,
        apiKey: Redacted.Redacted,
      ) => {
        switch (provider) {
          case "openai":
            return OpenAiLanguageModel.layer({ model }).pipe(
              Layer.provide(OpenAiClient.layer({ apiKey: apiKey as Redacted.Redacted })),
            );

          case "anthropic":
            return AnthropicLanguageModel.layer({ model }).pipe(
              Layer.provide(AnthropicClient.layer({ apiKey: apiKey as Redacted.Redacted })),
            );

          case "gemini":
            return GoogleLanguageModel.layer({ model }).pipe(
              Layer.provide(GoogleClient.layer({ apiKey: apiKey as Redacted.Redacted })),
            );
        }
      };

      const makeModel = (provider: LlmProvider, model: string) =>
        Effect.gen(function* () {
          const apiKey = yield* requireApiKey(provider);
          const languageModelLayer = makeLanguageModelLayer(provider, model, apiKey).pipe(
            Layer.provide(FetchHttpClient.layer),
          );

          return Model.make(provider, languageModelLayer);
        });

      const generate = Effect.fn("LlmRouter.generate")(function* (args: {
        readonly provider: LlmProvider;
        readonly model: string;
        readonly prompt: Prompt.RawInput;
      }) {
        const modelLayer = yield* makeModel(args.provider, args.model);

        return yield* LanguageModel.generateText({ prompt: args.prompt }).pipe(
          Effect.provide(modelLayer),
          Effect.map((r) => r.text.trim()),
          Effect.timeout("30 seconds"),
          Effect.retry(retryPolicy),
          Effect.mapError((cause) => LlmCallFailed.make({ provider: args.provider, cause })),
        );
      });

      return LlmRouter.of({ generate });
    }),
  );
}

export const LlmRouterLive = LlmRouter.layer;
