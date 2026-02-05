import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Model from "@effect/ai/Model";
import type * as Prompt from "@effect/ai/Prompt";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Generated as GoogleGenerated, GoogleClient, GoogleLanguageModel } from "@effect/ai-google";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  buildAnthropicOverrides,
  buildGeminiOverrides,
  buildOpenAiOverrides,
  buildOpenRouterBody,
} from "../lib/llmOverrides.js";
import { Settings } from "./Settings.js";

export const LlmProviderSchema = Schema.Literal("openai", "anthropic", "gemini", "openrouter");
export type LlmProvider = typeof LlmProviderSchema.Type;

export class MissingLlmApiKey extends Schema.TaggedError<MissingLlmApiKey>()("MissingLlmApiKey", {
  provider: LlmProviderSchema,
  envVar: Schema.String,
}) {}

export class LlmCallFailed extends Schema.TaggedError<LlmCallFailed>()("LlmCallFailed", {
  provider: LlmProviderSchema,
  cause: Schema.Defect,
}) {}

export class LlmContentError extends Schema.TaggedError<LlmContentError>()("LlmContentError", {
  provider: LlmProviderSchema,
  model: Schema.String,
}) {}

export type LlmRouterError = MissingLlmApiKey | LlmCallFailed | LlmContentError;

export type LlmResult = {
  readonly text: string;
  readonly reasoningText: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
};

export class LlmRouter extends Context.Tag("@agon/LlmRouter")<
  LlmRouter,
  {
    readonly generate: (args: {
      readonly provider: LlmProvider;
      readonly model: string;
      readonly prompt: Prompt.RawInput;
      readonly temperature?: number;
      readonly maxTokens?: number;
      readonly thinkingLevel?: string;
      readonly thinkingBudgetTokens?: number;
    }) => Effect.Effect<LlmResult, LlmRouterError>;
  }
>() {
  static readonly layer = Layer.effect(
    LlmRouter,
    Effect.gen(function* () {
      const settings = yield* Settings;

      // NOTE: we read API keys as optional so the app can boot even when only one provider is used.
      const openAiApiKey = yield* settings.getSetting("OPENAI_API_KEY");
      const anthropicApiKey = yield* settings.getSetting("ANTHROPIC_API_KEY");
      const googleApiKey = yield* settings.getSetting("GOOGLE_AI_API_KEY");
      const openRouterApiKey = yield* settings.getSetting("OPENROUTER_API_KEY");

      const openRouterHttpReferer = yield* settings
        .getSetting("OPENROUTER_HTTP_REFERER")
        .pipe(Effect.map(Option.map((r) => Redacted.value(r))));
      const openRouterTitle = yield* settings
        .getSetting("OPENROUTER_TITLE")
        .pipe(Effect.map(Option.map((r) => Redacted.value(r))));

      const sanitizeToken = (s: string) =>
        s
          .trim()
          .replace(/^"(.*)"$/, "$1")
          .replace(/^'(.*)'$/, "$1");

      const sanitizeRedacted = (r: Redacted.Redacted) =>
        Redacted.make(sanitizeToken(Redacted.value(r)));

      const requireApiKey = (provider: LlmProvider) => {
        switch (provider) {
          case "openai":
            return Option.isNone(openAiApiKey)
              ? Effect.fail(MissingLlmApiKey.make({ provider, envVar: "OPENAI_API_KEY" }))
              : Effect.succeed(sanitizeRedacted(openAiApiKey.value));

          case "anthropic":
            return Option.isNone(anthropicApiKey)
              ? Effect.fail(MissingLlmApiKey.make({ provider, envVar: "ANTHROPIC_API_KEY" }))
              : Effect.succeed(sanitizeRedacted(anthropicApiKey.value));

          case "gemini":
            return Option.isNone(googleApiKey)
              ? Effect.fail(MissingLlmApiKey.make({ provider, envVar: "GOOGLE_AI_API_KEY" }))
              : Effect.succeed(sanitizeRedacted(googleApiKey.value));

          case "openrouter":
            return Option.isNone(openRouterApiKey)
              ? Effect.fail(MissingLlmApiKey.make({ provider, envVar: "OPENROUTER_API_KEY" }))
              : Effect.succeed(sanitizeRedacted(openRouterApiKey.value));
        }
      };

      // Convert Prompt.RawInput to OpenAI chat messages format
      const promptToMessages = (prompt: Prompt.RawInput) => {
        const messages: Array<{ role: string; content: string }> = [];

        // Handle string input
        if (typeof prompt === "string") {
          messages.push({ role: "user", content: prompt });
          return messages;
        }

        // Handle Prompt object (has content array)
        const items = "content" in prompt ? prompt.content : prompt;

        for (const item of items) {
          if (typeof item === "string") {
            messages.push({ role: "user", content: item });
            continue;
          }

          if (item.role === "system") {
            messages.push({ role: "system", content: item.content as string });
          } else if (item.role === "user" || item.role === "assistant") {
            // Extract text from content parts
            const content = item.content;
            const text = Array.isArray(content)
              ? content
                  .map((part: unknown) => {
                    if (typeof part === "string") return part;
                    if (part && typeof part === "object" && "text" in part)
                      return (part as { text: string }).text;
                    return "";
                  })
                  .join("")
              : String(content);
            messages.push({ role: item.role, content: text });
          }
        }
        return messages;
      };

      // Direct OpenRouter chat completions call (bypasses @effect/ai-openai Responses API)
      const openRouterGenerate = (
        model: string,
        prompt: Prompt.RawInput,
        apiKey: Redacted.Redacted,
        options?: {
          readonly temperature?: number;
          readonly maxTokens?: number;
          readonly reasoningEffort?: string;
        },
      ) =>
        Effect.gen(function* () {
          const messages = promptToMessages(prompt);
          const headers: Record<string, string> = {
            Authorization: `Bearer ${Redacted.value(apiKey)}`,
            "Content-Type": "application/json",
          };
          if (Option.isSome(openRouterHttpReferer)) {
            headers["HTTP-Referer"] = openRouterHttpReferer.value;
          }
          if (Option.isSome(openRouterTitle)) {
            headers["X-Title"] = openRouterTitle.value;
          }

          const body = yield* Effect.try({
            try: () => JSON.stringify(buildOpenRouterBody(model, messages, options)),
            catch: (cause) => LlmCallFailed.make({ provider: "openrouter", cause }),
          });

          const res = yield* Effect.tryPromise({
            try: () =>
              fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers,
                body,
              }),
            catch: (cause) => LlmCallFailed.make({ provider: "openrouter", cause }),
          });

          if (!res.ok) {
            const bodyText = yield* Effect.tryPromise({
              try: () => res.text(),
              catch: (cause) => LlmCallFailed.make({ provider: "openrouter", cause }),
            });

            return yield* LlmCallFailed.make({
              provider: "openrouter",
              cause: new Error(`OpenRouter ${res.status}: ${bodyText}`),
            });
          }

          const data = (yield* Effect.tryPromise({
            try: () => res.json(),
            catch: (cause) => LlmCallFailed.make({ provider: "openrouter", cause }),
          })) as {
            choices?: Array<{
              message?: { content?: string; reasoning?: string; reasoning_content?: string };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };

          const content = data.choices?.[0]?.message?.content;
          if (typeof content !== "string") {
            return yield* LlmContentError.make({ provider: "openrouter", model });
          }

          const reasoningRaw =
            data.choices?.[0]?.message?.reasoning ?? data.choices?.[0]?.message?.reasoning_content;

          const inputTokens =
            typeof data.usage?.prompt_tokens === "number" ? data.usage.prompt_tokens : null;
          const outputTokens =
            typeof data.usage?.completion_tokens === "number" ? data.usage.completion_tokens : null;

          return {
            text: content.trim(),
            reasoningText: typeof reasoningRaw === "string" ? reasoningRaw.trim() : null,
            inputTokens,
            outputTokens,
          };
        });

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

          case "openrouter":
            // OpenRouter uses direct fetch, not @effect/ai layer
            return null as never;
        }
      };

      const generate = Effect.fn("LlmRouter.generate")(function* (args: {
        readonly provider: LlmProvider;
        readonly model: string;
        readonly prompt: Prompt.RawInput;
        readonly temperature?: number;
        readonly maxTokens?: number;
        readonly thinkingLevel?: string;
        readonly thinkingBudgetTokens?: number;
      }) {
        const apiKey = yield* requireApiKey(args.provider);

        // OpenRouter: use direct chat completions API
        if (args.provider === "openrouter") {
          return yield* openRouterGenerate(args.model, args.prompt, apiKey, {
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
            ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
            ...(args.thinkingLevel !== undefined ? { reasoningEffort: args.thinkingLevel } : {}),
          }).pipe(
            Effect.timeout("10 minutes"),
            Effect.mapError((cause) => {
              const tag =
                typeof cause === "object" && cause !== null && "_tag" in cause
                  ? (cause as { readonly _tag?: string })._tag
                  : undefined;

              return tag === "LlmContentError" || tag === "LlmCallFailed"
                ? (cause as LlmContentError | LlmCallFailed)
                : LlmCallFailed.make({ provider: args.provider, cause });
            }),
          );
        }

        // Other providers: use @effect/ai layers
        const languageModelLayer = makeLanguageModelLayer(args.provider, args.model, apiKey).pipe(
          Layer.provide(FetchHttpClient.layer),
        );
        const modelLayer = Model.make(args.provider, languageModelLayer);

        const base = LanguageModel.generateText({ prompt: args.prompt });

        const isGoogleThinkingLevel = Schema.is(GoogleGenerated.ThinkingConfigThinkingLevel);

        const normalizeGoogleConfig = (
          u: GoogleLanguageModel.Config.Service | undefined,
        ): GoogleLanguageModel.Config.Service => ({
          ...u,
          toolConfig: u?.toolConfig ?? {},
        });

        const withGoogleConfigOverride = <A, E, R>(
          self: Effect.Effect<A, E, R>,
          overrides: GoogleLanguageModel.Config.Service,
        ): Effect.Effect<A, E, R> =>
          Effect.flatMap(GoogleLanguageModel.Config.getOrUndefined, (current) => {
            const cur = normalizeGoogleConfig(current);

            // Merge nested generationConfig when present on both sides.
            const overrideGen = overrides.generationConfig;
            const curGen = cur.generationConfig;

            const mergedGenerationConfig =
              overrideGen !== undefined && overrideGen !== null
                ? typeof curGen === "object" && curGen !== null
                  ? { ...curGen, ...overrideGen }
                  : overrideGen
                : undefined;

            const next: GoogleLanguageModel.Config.Service = {
              ...cur,
              ...overrides,
              toolConfig: { ...cur.toolConfig, ...overrides.toolConfig },
              ...(mergedGenerationConfig !== undefined && {
                generationConfig: mergedGenerationConfig,
              }),
            };

            return Effect.provideService(self, GoogleLanguageModel.Config, next);
          });

        const withOverrides = (() => {
          switch (args.provider) {
            case "openai": {
              return base.pipe(
                OpenAiLanguageModel.withConfigOverride(
                  buildOpenAiOverrides(args) as OpenAiLanguageModel.Config.Service,
                ),
              );
            }

            case "anthropic": {
              return base.pipe(
                AnthropicLanguageModel.withConfigOverride(
                  buildAnthropicOverrides(args) as AnthropicLanguageModel.Config.Service,
                ),
              );
            }

            case "gemini": {
              const geminiOverrides = buildGeminiOverrides(args, isGoogleThinkingLevel);
              const hasOverrides =
                geminiOverrides.generationConfig !== undefined ||
                geminiOverrides.thinkingConfig !== undefined;
              if (!hasOverrides) return base;

              const overrides: GoogleLanguageModel.Config.Service = {
                toolConfig: {},
                ...geminiOverrides,
              };

              return withGoogleConfigOverride(base, overrides);
            }

            default:
              return base;
          }
        })();

        return yield* withOverrides.pipe(
          Effect.provide(modelLayer),
          Effect.map((r) => ({
            text: r.text.trim(),
            reasoningText: typeof r.reasoningText === "string" ? r.reasoningText.trim() : null,
            inputTokens: typeof r.usage?.inputTokens === "number" ? r.usage.inputTokens : null,
            outputTokens: typeof r.usage?.outputTokens === "number" ? r.usage.outputTokens : null,
          })),
          Effect.timeout("10 minutes"),
          Effect.mapError((cause) => LlmCallFailed.make({ provider: args.provider, cause })),
        );
      });

      return LlmRouter.of({ generate });
    }),
  );
}

export const LlmRouterLive = LlmRouter.layer;
