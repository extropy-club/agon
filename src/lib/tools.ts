import * as Tool from "@effect/ai/Tool";
import { Schema } from "effect";

/**
 * Tool for allowing agents to explicitly end a debate.
 *
 * When called, the arena will pause the room and post the provided summary.
 */
export const ExitDebate = Tool.make("exit_debate", {
  description: "End the debate and provide a final summary of key conclusions.",
  parameters: {
    summary: Schema.String,
  },
  // Return the same summary as the tool result.
  // (We primarily care about the tool call params, but the handler must conform.)
  success: Schema.String,
});

/**
 * OpenAI / OpenRouter Chat Completions function-tool definition.
 */
export const OpenAiExitDebateTool = {
  type: "function",
  function: {
    name: "exit_debate",
    description: "End the debate and provide a final summary of key conclusions.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
} as const;
