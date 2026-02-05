import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAiOverrides,
  buildAnthropicOverrides,
  buildGeminiOverrides,
  buildOpenRouterBody,
} from "../src/lib/llmOverrides.js";

// ---------------------------------------------------------------------------
// OpenAI (Responses API)
// ---------------------------------------------------------------------------

test("openai: thinkingLevel produces reasoning.effort (not reasoning_effort)", () => {
  const result = buildOpenAiOverrides({ thinkingLevel: "medium" });
  assert.deepEqual(result, { reasoning: { effort: "medium" } });
  assert.equal("reasoning_effort" in result, false, "must NOT have flat reasoning_effort key");
});

test("openai: all options together", () => {
  const result = buildOpenAiOverrides({
    temperature: 0.7,
    maxTokens: 4096,
    thinkingLevel: "high",
  });
  assert.deepEqual(result, {
    temperature: 0.7,
    max_output_tokens: 4096,
    reasoning: { effort: "high" },
  });
});

test("openai: no options produces empty object", () => {
  const result = buildOpenAiOverrides({});
  assert.deepEqual(result, {});
});

test("openai: temperature only", () => {
  const result = buildOpenAiOverrides({ temperature: 1.0 });
  assert.deepEqual(result, { temperature: 1.0 });
});

test("openai: maxTokens only", () => {
  const result = buildOpenAiOverrides({ maxTokens: 32000 });
  assert.deepEqual(result, { max_output_tokens: 32000 });
});

test("openai: thinkingLevel 'none' still sets reasoning.effort", () => {
  const result = buildOpenAiOverrides({ thinkingLevel: "none" });
  assert.deepEqual(result, { reasoning: { effort: "none" } });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

test("anthropic: thinkingBudgetTokens produces thinking.type='enabled'", () => {
  const result = buildAnthropicOverrides({ thinkingBudgetTokens: 2048 });
  assert.deepEqual(result, {
    thinking: { type: "enabled", budget_tokens: 2048 },
  });
});

test("anthropic: all options together", () => {
  const result = buildAnthropicOverrides({
    temperature: 0.5,
    maxTokens: 8192,
    thinkingBudgetTokens: 4096,
  });
  assert.deepEqual(result, {
    temperature: 0.5,
    max_tokens: 8192,
    thinking: { type: "enabled", budget_tokens: 4096 },
  });
});

test("anthropic: no options produces empty object", () => {
  const result = buildAnthropicOverrides({});
  assert.deepEqual(result, {});
});

test("anthropic: thinkingLevel is ignored (not used for Anthropic)", () => {
  const result = buildAnthropicOverrides({ thinkingLevel: "high" });
  assert.deepEqual(result, {});
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const alwaysValid = () => true;
const neverValid = () => false;

test("gemini: temperature and maxTokens go into generationConfig", () => {
  const result = buildGeminiOverrides({ temperature: 0.9, maxTokens: 2048 }, neverValid);
  assert.deepEqual(result, {
    generationConfig: { temperature: 0.9, maxOutputTokens: 2048 },
  });
});

test("gemini: thinkingBudgetTokens takes precedence over thinkingLevel", () => {
  const result = buildGeminiOverrides(
    { thinkingLevel: "HIGH", thinkingBudgetTokens: 10000 },
    alwaysValid,
  );
  assert.deepEqual(result.thinkingConfig, { thinkingBudget: 10000 });
});

test("gemini: thinkingLevel used when no thinkingBudgetTokens and validator passes", () => {
  const result = buildGeminiOverrides({ thinkingLevel: "HIGH" }, alwaysValid);
  assert.deepEqual(result.thinkingConfig, { thinkingLevel: "HIGH" });
});

test("gemini: thinkingLevel ignored when validator rejects", () => {
  const result = buildGeminiOverrides({ thinkingLevel: "INVALID" }, neverValid);
  assert.equal(result.thinkingConfig, undefined);
});

test("gemini: no options produces empty object", () => {
  const result = buildGeminiOverrides({}, neverValid);
  assert.equal(result.generationConfig, undefined);
  assert.equal(result.thinkingConfig, undefined);
});

// ---------------------------------------------------------------------------
// OpenRouter (Chat Completions API)
// ---------------------------------------------------------------------------

test("openrouter: reasoning_effort is flat (not nested)", () => {
  const result = buildOpenRouterBody("model-x", [{ role: "user", content: "hi" }], {
    reasoningEffort: "medium",
  });
  assert.equal(result.reasoning_effort, "medium");
  assert.equal("reasoning" in result, false, "must NOT have nested reasoning key");
});

test("openrouter: all options", () => {
  const msgs = [{ role: "user", content: "hello" }];
  const result = buildOpenRouterBody("gpt-5", msgs, {
    temperature: 0.8,
    maxTokens: 1024,
    reasoningEffort: "high",
  });
  assert.deepEqual(result, {
    model: "gpt-5",
    messages: msgs,
    temperature: 0.8,
    max_tokens: 1024,
    reasoning_effort: "high",
  });
});

test("openrouter: no options includes only model and messages", () => {
  const msgs = [{ role: "user", content: "test" }];
  const result = buildOpenRouterBody("model-y", msgs);
  assert.deepEqual(result, { model: "model-y", messages: msgs });
});
