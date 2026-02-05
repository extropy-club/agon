/**
 * Pure functions for building LLM provider config overrides and request bodies.
 *
 * Extracted from LlmRouter so they can be unit-tested without Effect layers / API keys.
 */

export type LlmGenerateArgs = {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinkingLevel?: string;
  readonly thinkingBudgetTokens?: number;
};

// ---------------------------------------------------------------------------
// OpenAI (Responses API)
// ---------------------------------------------------------------------------

/**
 * Build the config override object for `OpenAiLanguageModel.withConfigOverride`.
 *
 * The Responses API uses `reasoning.effort` (nested object), NOT the flat
 * `reasoning_effort` key from the older Chat Completions API.
 */
export const buildOpenAiOverrides = (args: LlmGenerateArgs): Record<string, unknown> => ({
  ...(args.temperature !== undefined && { temperature: args.temperature }),
  ...(args.maxTokens !== undefined && { max_output_tokens: args.maxTokens }),
  ...(args.thinkingLevel !== undefined && {
    reasoning: { effort: args.thinkingLevel },
  }),
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

export const buildAnthropicOverrides = (args: LlmGenerateArgs): Record<string, unknown> => ({
  ...(args.temperature !== undefined && { temperature: args.temperature }),
  ...(args.maxTokens !== undefined && { max_tokens: args.maxTokens }),
  ...(args.thinkingBudgetTokens !== undefined && {
    thinking: {
      type: "enabled" as const,
      budget_tokens: args.thinkingBudgetTokens,
    },
  }),
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

export const buildGeminiOverrides = (
  args: LlmGenerateArgs,
  isValidThinkingLevel: (v: string) => boolean,
): { generationConfig?: Record<string, unknown>; thinkingConfig?: Record<string, unknown> } => {
  const generationConfig: Record<string, unknown> = {
    ...(args.temperature !== undefined && { temperature: args.temperature }),
    ...(args.maxTokens !== undefined && { maxOutputTokens: args.maxTokens }),
  };

  const thinkingConfig =
    args.thinkingBudgetTokens !== undefined
      ? { thinkingBudget: args.thinkingBudgetTokens }
      : args.thinkingLevel !== undefined && isValidThinkingLevel(args.thinkingLevel)
        ? { thinkingLevel: args.thinkingLevel }
        : undefined;

  return {
    ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
    ...(thinkingConfig !== undefined && { thinkingConfig }),
  };
};

// ---------------------------------------------------------------------------
// OpenRouter (Chat Completions API — uses flat `reasoning_effort`)
// ---------------------------------------------------------------------------

export const buildOpenRouterBody = (
  model: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
  options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly reasoningEffort?: string;
  },
): Record<string, unknown> => ({
  model,
  messages,
  ...(options?.temperature !== undefined && { temperature: options.temperature }),
  ...(options?.maxTokens !== undefined && { max_tokens: options.maxTokens }),
  ...(options?.reasoningEffort !== undefined && { reasoning_effort: options.reasoningEffort }),
});
