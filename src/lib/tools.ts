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

/**
 * Tool for saving knowledge facts to the agent's personal knowledge base.
 *
 * Use this when the debate produces durable takeaways worth remembering
 * across future rooms.
 */
export const MemoryAdd = Tool.make("memory_add", {
  description:
    "Save one or more knowledge facts, theorems, insights, or conclusions to your personal knowledge base. Use this to remember important information across debates.",
  parameters: {
    memories: Schema.Array(Schema.Struct({ content: Schema.String })),
  },
  success: Schema.Struct({
    ok: Schema.Boolean,
    inserted: Schema.Int,
  }),
});

/**
 * Tool for searching the agent's personal knowledge base.
 */
export const MemorySearch = Tool.make("memory_search", {
  description:
    "Search your personal knowledge base for facts and insights from past debates. Use keywords related to what you want to recall.",
  parameters: {
    query: Schema.String,
    limit: Schema.Int.annotations({ description: "Maximum number of results to return" }),
  },
  success: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      content: Schema.String,
      roomId: Schema.Int,
      createdAt: Schema.String,
    }),
  ),
});

/**
 * Tool for reading a summary of a past debate room.
 */
export const ThreadRead = Tool.make("thread_read", {
  description: "Read a summary of what happened in a past debate room.",
  parameters: {
    roomId: Schema.Int,
  },
  success: Schema.Struct({
    title: Schema.String,
    topic: Schema.String,
    summary: Schema.NullOr(Schema.String),
    status: Schema.String,
  }),
});

/**
 * OpenAI / OpenRouter Chat Completions function-tool definition.
 */
export const OpenAiMemoryAddTool = {
  type: "function",
  function: {
    name: "memory_add",
    description: "Save one or more knowledge facts to your personal knowledge base.",
    parameters: {
      type: "object",
      properties: {
        memories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "A knowledge fact to remember",
              },
            },
            required: ["content"],
            additionalProperties: false,
          },
          description: "Array of knowledge facts to save",
        },
      },
      required: ["memories"],
      additionalProperties: false,
    },
  },
} as const;

/**
 * OpenAI / OpenRouter Chat Completions function-tool definition.
 */
export const OpenAiMemorySearchTool = {
  type: "function",
  function: {
    name: "memory_search",
    description: "Search your personal knowledge base for facts and insights from past debates.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords describing what you want to recall",
        },
        limit: {
          type: "integer",
          description: "Maximum number of results to return (default: 5)",
        },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
  },
} as const;

/**
 * OpenAI / OpenRouter Chat Completions function-tool definition.
 */
export const OpenAiThreadReadTool = {
  type: "function",
  function: {
    name: "thread_read",
    description: "Read a summary of what happened in a past debate room.",
    parameters: {
      type: "object",
      properties: {
        roomId: {
          type: "integer",
          description: "The debate room id to read",
        },
      },
      required: ["roomId"],
      additionalProperties: false,
    },
  },
} as const;
