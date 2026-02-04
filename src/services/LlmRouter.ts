import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Model from "@effect/ai/Model";
import type * as Prompt from "@effect/ai/Prompt";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
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

export type LlmRouterError = MissingLlmApiKey | LlmCallFailed;

export class LlmRouter extends Context.Tag("@agon/LlmRouter")<
  LlmRouter,
  {
    readonly generate: (args: {
      readonly provider: LlmProvider;
      readonly model: string;
      readonly prompt: Prompt.RawInput;
      readonly temperature?: number;
      readonly maxTokens?: number;
      readonly thinkingLevel?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
      readonly thinkingBudgetTokens?: number;
    }) => Effect.Effect<string, LlmRouterError>;
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
              body: JSON.stringify({
                model,
                messages,
                ...(options?.temperature !== undefined && { temperature: options.temperature }),
                ...(options?.maxTokens !== undefined && { max_tokens: options.maxTokens }),
                ...(options?.reasoningEffort !== undefined && {
                  reasoning_effort: options.reasoningEffort,
                }),
              }),
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
        readonly temperature?: number;
        readonly maxTokens?: number;
        readonly thinkingLevel?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
        readonly thinkingBudgetTokens?: number;
      }) {
        const apiKey = yield* requireApiKey(args.provider);

        // OpenRouter: use direct chat completions API
        if (args.provider === "openrouter") {
          // OpenRouter supports reasoning_effort for compatible models (o-series, gpt-5, etc.)
          const orEffort =
            args.thinkingLevel !== undefined && args.thinkingLevel !== "xhigh"
              ? args.thinkingLevel
              : args.thinkingLevel === "xhigh"
                ? "high"
                : undefined;

          return yield* openRouterGenerate(args.model, args.prompt, apiKey, {
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
            ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
            ...(orEffort !== undefined ? { reasoningEffort: orEffort } : {}),
          }).pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError((cause) => LlmCallFailed.make({ provider: args.provider, cause })),
          );
        }

        // Other providers: use @effect/ai layers
        const languageModelLayer = makeLanguageModelLayer(args.provider, args.model, apiKey).pipe(
          Layer.provide(FetchHttpClient.layer),
        );
        const modelLayer = Model.make(args.provider, languageModelLayer);

        const base = LanguageModel.generateText({ prompt: args.prompt });

        const withGoogleConfigOverride = <A, E, R>(
          self: Effect.Effect<A, E, R>,
          overrides: GoogleLanguageModel.Config.Service,
        ): Effect.Effect<A, E, R> =>
          Effect.flatMap(GoogleLanguageModel.Config.getOrUndefined, (current) => {
            const cur = (current ?? {}) as unknown as Record<string, unknown>;
            const next = { ...cur, ...(overrides as unknown as Record<string, unknown>) };

            // Merge nested generationConfig when present on both sides.
            if ("generationConfig" in overrides) {
              const curGen = cur["generationConfig"] as Record<string, unknown> | undefined;
              const overrideGen = (overrides as unknown as Record<string, unknown>)[
                "generationConfig"
              ] as Record<string, unknown> | undefined;
              if (overrideGen) {
                next["generationConfig"] = { ...curGen, ...overrideGen };
              }
            }

            return Effect.provideService(self, GoogleLanguageModel.Config, next as never);
          });

        const withOverrides = (() => {
          switch (args.provider) {
            case "openai": {
              const isOModel = args.model.toLowerCase().startsWith("o");
              const isGpt5 = args.model.toLowerCase().startsWith("gpt-5");
              const supportsReasoning = isOModel || isGpt5;

              // OpenAI accepts: none, minimal, low, medium, high
              // Map xhigh → high (not in OpenAI spec)
              const mapOpenAiEffort = (
                level: string,
              ): "none" | "minimal" | "low" | "medium" | "high" =>
                level === "xhigh"
                  ? "high"
                  : (level as "none" | "minimal" | "low" | "medium" | "high");

              const overrides = {
                ...(args.temperature !== undefined && { temperature: args.temperature }),
                ...(args.maxTokens !== undefined && { max_output_tokens: args.maxTokens }),
                ...(supportsReasoning &&
                  args.thinkingLevel !== undefined && {
                    reasoning_effort: mapOpenAiEffort(args.thinkingLevel),
                  }),
              };

              return base.pipe(
                OpenAiLanguageModel.withConfigOverride(
                  overrides as OpenAiLanguageModel.Config.Service,
                ),
              );
            }

            case "anthropic": {
              // Anthropic uses budget_tokens (≥1024) for extended thinking.
              // none/minimal → disable thinking; low/medium/high/xhigh → increasing budgets.
              const budgetFromLevel = (
                level: "none" | "minimal" | "low" | "medium" | "high" | "xhigh",
              ): number | null => {
                switch (level) {
                  case "none":
                  case "minimal":
                    return null; // disable thinking
                  case "low":
                    return 1024;
                  case "medium":
                    return 4096;
                  case "high":
                    return 16384;
                  case "xhigh":
                    return 32768;
                }
              };

              const thinkingBudget =
                args.thinkingBudgetTokens !== undefined
                  ? args.thinkingBudgetTokens
                  : args.thinkingLevel !== undefined
                    ? budgetFromLevel(args.thinkingLevel)
                    : undefined;

              const overrides = {
                ...(args.temperature !== undefined && { temperature: args.temperature }),
                ...(args.maxTokens !== undefined && { max_tokens: args.maxTokens }),
                ...(thinkingBudget !== undefined &&
                  thinkingBudget !== null && {
                    thinking: { type: "enabled" as const, budget_tokens: thinkingBudget },
                  }),
              };

              return base.pipe(
                AnthropicLanguageModel.withConfigOverride(
                  overrides as AnthropicLanguageModel.Config.Service,
                ),
              );
            }

            case "gemini": {
              const generationConfig = {
                ...(args.temperature !== undefined && { temperature: args.temperature }),
                ...(args.maxTokens !== undefined && { maxOutputTokens: args.maxTokens }),
              };

              // Gemini 3: thinkingLevel LOW/HIGH only (cannot disable).
              // Map none/minimal/low → LOW; medium/high/xhigh → HIGH.
              const mapGeminiLevel = (level: string): "LOW" | "HIGH" =>
                level === "none" || level === "minimal" || level === "low" ? "LOW" : "HIGH";

              const thinkingConfig =
                args.thinkingBudgetTokens !== undefined
                  ? { thinkingBudget: args.thinkingBudgetTokens }
                  : args.thinkingLevel !== undefined
                    ? { thinkingLevel: mapGeminiLevel(args.thinkingLevel) }
                    : undefined;

              const hasOverrides =
                Object.keys(generationConfig).length > 0 || thinkingConfig !== undefined;
              if (!hasOverrides) return base;

              const overrides = {
                ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
                ...(thinkingConfig !== undefined && { thinkingConfig }),
              } as unknown as GoogleLanguageModel.Config.Service;

              return withGoogleConfigOverride(base, overrides);
            }

            default:
              return base;
          }
        })();

        return yield* withOverrides.pipe(
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
