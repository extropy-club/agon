import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Model from "@effect/ai/Model";
import type * as Prompt from "@effect/ai/Prompt";
import * as Toolkit from "@effect/ai/Toolkit";
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
import {
  ExitDebate,
  MemoryAdd,
  MemorySearch,
  OpenAiExitDebateTool,
  OpenAiMemoryAddTool,
  OpenAiMemorySearchTool,
  OpenAiThreadReadTool,
  ThreadRead,
} from "../lib/tools.js";
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

export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

export type LlmResult = {
  /**
   * Generated assistant text.
   *
   * NOTE: when `exit_debate` is called, providers may return *no* regular text.
   * In that case we set `text` to the exit summary for convenience.
   */
  readonly text: string;
  readonly reasoningText: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;

  /**
   * When not null, the model requested to end the debate.
   */
  readonly exitSummary: string | null;

  /**
   * Tool calls requested by the model.
   */
  readonly toolCalls: ReadonlyArray<ToolCall>;
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
      readonly toolResults?: ReadonlyArray<{
        readonly toolCallId: string;
        readonly name: string;
        readonly result: string;
      }>;
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

      type OpenAiToolCall = {
        readonly id: string;
        readonly type: "function";
        readonly function: { readonly name: string; readonly arguments: string };
      };

      type OpenAiMessage =
        | { readonly role: "system" | "user"; readonly content: string }
        | {
            readonly role: "assistant";
            readonly content: string | null;
            readonly tool_calls?: ReadonlyArray<OpenAiToolCall>;
          }
        | {
            readonly role: "tool";
            readonly tool_call_id: string;
            readonly content: string;
          };

      const safeJsonStringify = (u: unknown): string => {
        if (typeof u === "string") return u;
        try {
          return JSON.stringify(u);
        } catch {
          return String(u);
        }
      };

      const parseToolArguments = (raw: unknown): Record<string, unknown> => {
        if (typeof raw === "string") {
          try {
            const parsed = JSON.parse(raw) as unknown;
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
          } catch {
            return {};
          }
        }

        return raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      };

      const extractTextFromParts = (content: unknown): string => {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return content === undefined ? "" : String(content);

        return content
          .map((part: unknown) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            if ("text" in part && typeof (part as { text?: unknown }).text === "string") {
              return (part as { text: string }).text;
            }
            return "";
          })
          .join("");
      };

      const promptToOpenAiMessages = (
        prompt: Prompt.RawInput,
        toolResults?: ReadonlyArray<{ toolCallId: string; name: string; result: string }>,
      ): Array<OpenAiMessage> => {
        const out: Array<OpenAiMessage> = [];

        if (typeof prompt === "string") {
          out.push({ role: "user", content: prompt });
        } else {
          const items: Iterable<Prompt.MessageEncoded> =
            (prompt as { content?: ReadonlyArray<Prompt.MessageEncoded> }).content ??
            (prompt as Iterable<Prompt.MessageEncoded>);

          for (const item of items) {
            if (typeof item === "string") {
              out.push({ role: "user", content: item });
              continue;
            }

            if (!item || typeof item !== "object" || !("role" in item)) continue;

            const role = (item as { role?: unknown }).role;
            const content = (item as { content?: unknown }).content;

            if (role === "system") {
              out.push({ role: "system", content: extractTextFromParts(content) });
              continue;
            }

            if (role === "user") {
              out.push({ role: "user", content: extractTextFromParts(content) });
              continue;
            }

            if (role === "assistant") {
              const parts = Array.isArray(content) ? content : [];

              const text = extractTextFromParts(content).trim();

              const toolCalls: Array<OpenAiToolCall> = [];
              for (const part of parts) {
                if (!part || typeof part !== "object") continue;
                if ((part as { type?: unknown }).type !== "tool-call") continue;

                const id = (part as { id?: unknown }).id;
                const name = (part as { name?: unknown }).name;
                const params = (part as { params?: unknown }).params;

                if (typeof id !== "string" || typeof name !== "string") continue;

                toolCalls.push({
                  id,
                  type: "function",
                  function: {
                    name,
                    arguments: safeJsonStringify(params ?? {}),
                  },
                });
              }

              out.push({
                role: "assistant",
                content: text.length > 0 ? text : null,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              });

              continue;
            }

            if (role === "tool") {
              const parts = Array.isArray(content) ? content : [];

              for (const part of parts) {
                if (!part || typeof part !== "object") continue;
                if ((part as { type?: unknown }).type !== "tool-result") continue;

                const id = (part as { id?: unknown }).id;
                const result = (part as { result?: unknown }).result;
                if (typeof id !== "string") continue;

                out.push({
                  role: "tool",
                  tool_call_id: id,
                  content: safeJsonStringify(result),
                });
              }
              continue;
            }
          }
        }

        if (toolResults && toolResults.length > 0) {
          for (const r of toolResults) {
            out.push({ role: "tool", tool_call_id: r.toolCallId, content: r.result });
          }
        }

        return out;
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
        toolResults?: ReadonlyArray<{ toolCallId: string; name: string; result: string }>,
      ) =>
        Effect.gen(function* () {
          const messages = promptToOpenAiMessages(prompt, toolResults);
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
            try: () =>
              JSON.stringify({
                ...buildOpenRouterBody(model, messages, options),
                tools: [
                  OpenAiExitDebateTool,
                  OpenAiMemoryAddTool,
                  OpenAiMemorySearchTool,
                  OpenAiThreadReadTool,
                ],
                tool_choice: "auto",
              }),
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
              message?: {
                content?: string;
                reasoning?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: unknown };
                }>;
              };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };

          const message = data.choices?.[0]?.message;

          const toolCallsRaw = message?.tool_calls;
          const toolCalls: Array<ToolCall> = [];

          if (Array.isArray(toolCallsRaw)) {
            for (const call of toolCallsRaw) {
              if (!call || typeof call !== "object") continue;

              const id = typeof call.id === "string" ? call.id : crypto.randomUUID();
              const fn = (call as { function?: unknown }).function;

              if (!fn || typeof fn !== "object") continue;
              const name = (fn as { name?: unknown }).name;

              if (typeof name !== "string" || name.trim().length === 0) continue;

              const argsRaw = (fn as { arguments?: unknown }).arguments;
              const args = parseToolArguments(argsRaw);

              toolCalls.push({ id, name, arguments: args });
            }
          }

          const exitCall = toolCalls.find((c) => c.name === "exit_debate");
          const exitSummary =
            exitCall && typeof exitCall.arguments.summary === "string"
              ? exitCall.arguments.summary.trim()
              : null;

          const contentRaw = message?.content;
          const contentText = typeof contentRaw === "string" ? contentRaw.trim() : "";

          // If the model produced neither text nor tool calls, it's invalid.
          if (contentText.length === 0 && toolCalls.length === 0) {
            return yield* LlmContentError.make({ provider: "openrouter", model });
          }

          const reasoningRaw = message?.reasoning ?? message?.reasoning_content;

          const inputTokens =
            typeof data.usage?.prompt_tokens === "number" ? data.usage.prompt_tokens : null;
          const outputTokens =
            typeof data.usage?.completion_tokens === "number" ? data.usage.completion_tokens : null;

          return {
            text: exitSummary ?? contentText,
            reasoningText: typeof reasoningRaw === "string" ? reasoningRaw.trim() : null,
            inputTokens,
            outputTokens,
            exitSummary,
            toolCalls,
          } satisfies LlmResult;
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

      const toolKit = Toolkit.make(ExitDebate, MemoryAdd, MemorySearch, ThreadRead);

      // NOTE: @effect/ai toolkits built with `Tool.make` require handlers in the environment,
      // even when tool call resolution is disabled.
      //
      // We provide no-op handlers here so `LlmRouter.generate` has no extra context requirements.
      // Tool execution is handled at the workflow level.
      const toolKitLayer = toolKit.toLayer({
        exit_debate: ({ summary }) => Effect.succeed(summary),
        memory_add: () => Effect.succeed({ ok: false as const, inserted: 0 }),
        memory_search: () => Effect.succeed([]),
        thread_read: () =>
          Effect.succeed({ title: "", topic: "", summary: null, status: "" } as const),
      });

      const normalizePromptWithToolResults = (args: {
        readonly prompt: Prompt.RawInput;
        readonly toolResults?: ReadonlyArray<{ toolCallId: string; name: string; result: string }>;
      }): Prompt.RawInput => {
        if (!args.toolResults || args.toolResults.length === 0) return args.prompt;

        const messages: Array<Prompt.MessageEncoded> =
          typeof args.prompt === "string"
            ? ([
                {
                  role: "user",
                  content: [{ type: "text", text: args.prompt }],
                },
              ] satisfies Array<Prompt.MessageEncoded>)
            : Array.from(
                (args.prompt as { content?: ReadonlyArray<Prompt.MessageEncoded> }).content ??
                  (args.prompt as Iterable<Prompt.MessageEncoded>),
              );

        const toolMessage: Prompt.ToolMessageEncoded = {
          role: "tool",
          content: args.toolResults.map((r) => {
            let parsed: unknown = r.result;
            try {
              parsed = JSON.parse(r.result) as unknown;
            } catch {
              // keep raw string
            }

            return {
              type: "tool-result",
              id: r.toolCallId,
              name: r.name,
              isFailure: false,
              result: parsed,
              providerExecuted: false,
            } satisfies Prompt.ToolResultPartEncoded;
          }),
        };

        return [...messages, toolMessage];
      };

      const generate = Effect.fn("LlmRouter.generate")(function* (args: {
        readonly provider: LlmProvider;
        readonly model: string;
        readonly prompt: Prompt.RawInput;
        readonly temperature?: number;
        readonly maxTokens?: number;
        readonly thinkingLevel?: string;
        readonly thinkingBudgetTokens?: number;
        readonly toolResults?: ReadonlyArray<{
          readonly toolCallId: string;
          readonly name: string;
          readonly result: string;
        }>;
      }) {
        const apiKey = yield* requireApiKey(args.provider);

        // OpenRouter: use direct chat completions API
        if (args.provider === "openrouter") {
          return yield* openRouterGenerate(
            args.model,
            args.prompt,
            apiKey,
            {
              ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
              ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
              ...(args.thinkingLevel !== undefined ? { reasoningEffort: args.thinkingLevel } : {}),
            },
            args.toolResults,
          ).pipe(
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

        const prompt = args.toolResults
          ? normalizePromptWithToolResults({ prompt: args.prompt, toolResults: args.toolResults })
          : args.prompt;

        // Other providers: use @effect/ai layers
        const languageModelLayer = makeLanguageModelLayer(args.provider, args.model, apiKey).pipe(
          Layer.provide(FetchHttpClient.layer),
        );
        const modelLayer = Model.make(args.provider, languageModelLayer);

        const base = LanguageModel.generateText({
          prompt,
          toolkit: toolKit,
          toolChoice: "auto",
          disableToolCallResolution: true,
        });

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
          Effect.provide(toolKitLayer),
          Effect.map((r) => {
            const toolCalls = r.toolCalls.map((c) => ({
              id: c.id,
              name: c.name,
              arguments:
                c.params && typeof c.params === "object" && !Array.isArray(c.params)
                  ? (c.params as Record<string, unknown>)
                  : {},
            }));

            const exitCall = toolCalls.find((c) => c.name === "exit_debate");
            const exitSummary =
              exitCall && typeof exitCall.arguments.summary === "string"
                ? exitCall.arguments.summary.trim()
                : null;

            const textRaw = r.text.trim();
            const text = textRaw.length > 0 ? textRaw : (exitSummary ?? "");

            return {
              text,
              reasoningText: typeof r.reasoningText === "string" ? r.reasoningText.trim() : null,
              inputTokens: typeof r.usage?.inputTokens === "number" ? r.usage.inputTokens : null,
              outputTokens: typeof r.usage?.outputTokens === "number" ? r.usage.outputTokens : null,
              exitSummary,
              toolCalls,
            } satisfies LlmResult;
          }),
          Effect.timeout("10 minutes"),
          Effect.mapError((cause) => LlmCallFailed.make({ provider: args.provider, cause })),
        );
      });

      return LlmRouter.of({ generate });
    }),
  );
}

export const LlmRouterLive = LlmRouter.layer;
