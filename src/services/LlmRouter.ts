import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Model from "@effect/ai/Model";
import type * as Prompt from "@effect/ai/Prompt";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

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
      const openRouterApiKey = yield* Config.option(Config.redacted("OPENROUTER_API_KEY"));

      const openRouterHttpReferer = yield* Config.option(Config.string("OPENROUTER_HTTP_REFERER"));
      const openRouterTitle = yield* Config.option(Config.string("OPENROUTER_TITLE"));

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
      ) =>
        Effect.tryPromise({
          try: async () => {
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

            const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers,
              body: JSON.stringify({ model, messages }),
            });

            if (!res.ok) {
              const body = await res.text();
              throw new Error(`OpenRouter ${res.status}: ${body}`);
            }

            const data = (await res.json()) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            const content = data.choices?.[0]?.message?.content;
            if (typeof content !== "string") {
              throw new Error("OpenRouter returned no content");
            }
            return content.trim();
          },
          catch: (e) => e,
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
      }) {
        const apiKey = yield* requireApiKey(args.provider);

        // OpenRouter: use direct chat completions API
        if (args.provider === "openrouter") {
          return yield* openRouterGenerate(args.model, args.prompt, apiKey).pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) => LlmCallFailed.make({ provider: args.provider, cause })),
          );
        }

        // Other providers: use @effect/ai layers
        const languageModelLayer = makeLanguageModelLayer(args.provider, args.model, apiKey).pipe(
          Layer.provide(FetchHttpClient.layer),
        );
        const modelLayer = Model.make(args.provider, languageModelLayer);

        return yield* LanguageModel.generateText({ prompt: args.prompt }).pipe(
          Effect.provide(modelLayer),
          Effect.map((r) => r.text.trim()),
          Effect.timeout("30 seconds"),
          Effect.mapError((cause) => LlmCallFailed.make({ provider: args.provider, cause })),
        );
      });

      return LlmRouter.of({ generate });
    }),
  );
}

export const LlmRouterLive = LlmRouter.layer;
