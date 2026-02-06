import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Schema } from "effect";
import { agents, commandSessions } from "../d1/schema.js";
import type { ModelInfo, ModelsDevError } from "./ModelsDev.js";

export const DiscordAgentCommandSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal(2),
  channel_id: Schema.String,
  member: Schema.Struct({
    user: Schema.Struct({
      id: Schema.String,
    }),
  }),
  data: Schema.Struct({
    name: Schema.String,
    options: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          type: Schema.Number,
          options: Schema.optional(Schema.Array(Schema.Unknown)),
        }),
      ),
    ),
  }),
});

export type DiscordAgentCommand = typeof DiscordAgentCommandSchema.Type;

export const DiscordModalSubmitSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal(5),
  channel_id: Schema.String,
  member: Schema.Struct({
    user: Schema.Struct({
      id: Schema.String,
    }),
  }),
  data: Schema.Struct({
    custom_id: Schema.String,
    components: Schema.Array(
      Schema.Struct({
        components: Schema.Array(
          Schema.Struct({
            custom_id: Schema.String,
            value: Schema.String,
          }),
        ),
      }),
    ),
  }),
});

export type DiscordModalSubmit = typeof DiscordModalSubmitSchema.Type;

export const DiscordComponentInteractionSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal(3),
  channel_id: Schema.String,
  member: Schema.Struct({
    user: Schema.Struct({
      id: Schema.String,
    }),
  }),
  data: Schema.Struct({
    custom_id: Schema.String,
    values: Schema.optional(Schema.Array(Schema.String)),
  }),
});

export type DiscordComponentInteraction = typeof DiscordComponentInteractionSchema.Type;

export type AgentCreateState = {
  step: "provider";
  name: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  thinkingLevel?: string;
  thinkingBudgetTokens?: number;
};

const SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

export type ModelsDevService = {
  readonly fetchModels: () => Effect.Effect<ReadonlyArray<ModelInfo>, ModelsDevError>;
  readonly getModelsByProvider: (
    provider: string,
  ) => Effect.Effect<ReadonlyArray<ModelInfo>, ModelsDevError>;
};

export class DiscordAgentService {
  constructor(
    private db: DrizzleD1Database,
    private modelsDev: ModelsDevService,
  ) {}

  /**
   * Check if command is /agon agent create
   */
  static isAgentCreateCommand(interaction: unknown): boolean {
    const result = Schema.decodeUnknownOption(DiscordAgentCommandSchema)(interaction);
    if (result._tag === "None") return false;

    const cmd = result.value;
    if (cmd.data.name !== "agon") return false;

    const agentGroup = cmd.data.options?.find((o) => o.name === "agent");
    if (!agentGroup) return false;

    const createCmd = agentGroup.options?.find((o: unknown) => {
      const opt = o as { name: string; type: number };
      return opt.name === "create" && opt.type === 1;
    });

    return !!createCmd;
  }

  /**
   * Handle /agon agent create - trigger modal
   */
  handleAgentCreateModal(interaction: DiscordAgentCommand): Effect.Effect<Response, never, never> {
    return Effect.succeed(
      new Response(
        JSON.stringify({
          type: 9, // MODAL
          data: {
            custom_id: "agon:agent:create:modal",
            title: "Create New Agent",
            components: [
              {
                type: 1, // Action Row
                components: [
                  {
                    type: 4, // Text Input
                    custom_id: "agent_name",
                    label: "Agent Name",
                    style: 1, // SHORT
                    required: true,
                    max_length: 100,
                    placeholder: "e.g., Debate Moderator",
                  },
                ],
              },
              {
                type: 1, // Action Row
                components: [
                  {
                    type: 4, // Text Input
                    custom_id: "system_prompt",
                    label: "System Prompt",
                    style: 2, // PARAGRAPH
                    required: true,
                    max_length: 4000,
                    placeholder: "Describe the agent's personality and role...",
                  },
                ],
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }

  /**
   * Check if interaction is a modal submit for agent creation
   */
  static isAgentCreateModalSubmit(interaction: unknown): boolean {
    const result = Schema.decodeUnknownOption(DiscordModalSubmitSchema)(interaction);
    if (result._tag === "None") return false;
    return result.value.data.custom_id === "agon:agent:create:modal";
  }

  /**
   * Handle modal submit - create session and show provider selection
   */
  handleModalSubmit(interaction: DiscordModalSubmit): Effect.Effect<Response, Error, never> {
    return Effect.gen(this, function* () {
      // Extract form values
      const name =
        interaction.data.components[0]?.components.find((c) => c.custom_id === "agent_name")
          ?.value || "";
      const systemPrompt =
        interaction.data.components[1]?.components.find((c) => c.custom_id === "system_prompt")
          ?.value || "";

      if (!name || !systemPrompt) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: "Error: Missing required fields.",
              flags: 64,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Create session
      const sessionId = crypto.randomUUID();
      const now = Date.now();
      const state: AgentCreateState = {
        step: "provider",
        name,
        systemPrompt,
      };

      yield* Effect.tryPromise({
        try: () =>
          this.db
            .insert(commandSessions)
            .values({
              id: sessionId,
              kind: "agent_create",
              userId: interaction.member.user.id,
              stateJson: JSON.stringify(state),
              createdAtMs: now,
              expiresAtMs: now + SESSION_EXPIRY_MS,
            })
            .run(),
        catch: (e): Error => new Error(`Failed to create session: ${e}`),
      });

      // Show provider selection
      return new Response(
        JSON.stringify({
          type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            content: `**Create Agent: ${name}**\n\nStep 2/3: Select a provider`,
            components: [
              {
                type: 1, // Action Row
                components: [
                  {
                    type: 3, // String Select
                    custom_id: `agon:agent:create:provider:${sessionId}`,
                    placeholder: "Choose a provider",
                    options: [
                      { label: "OpenAI", value: "openai", description: "GPT models" },
                      { label: "Anthropic", value: "anthropic", description: "Claude models" },
                      { label: "Gemini", value: "gemini", description: "Google models" },
                      {
                        label: "OpenRouter",
                        value: "openrouter",
                        description: "Multi-provider routing",
                      },
                    ],
                  },
                ],
              },
              {
                type: 1, // Action Row
                components: [
                  {
                    type: 2, // Button
                    custom_id: `agon:agent:create:save:${sessionId}`,
                    label: "Save with defaults",
                    style: 3, // SUCCESS (green)
                  },
                ],
              },
            ],
            flags: 64, // EPHEMERAL
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
  }

  /**
   * Check if interaction is a component interaction for agent creation
   */
  static isAgentCreateComponent(interaction: unknown): boolean {
    const result = Schema.decodeUnknownOption(DiscordComponentInteractionSchema)(interaction);
    if (result._tag === "None") return false;
    const customId = result.value.data.custom_id;
    return customId.startsWith("agon:agent:create:");
  }

  /**
   * Handle component interactions
   */
  handleComponentInteraction(
    interaction: DiscordComponentInteraction,
  ): Effect.Effect<Response, Error, never> {
    return Effect.gen(this, function* () {
      const customId = interaction.data.custom_id;
      const parts = customId.split(":");
      const action = parts[3];
      const sessionId = parts[4];

      // Load session
      const session = yield* Effect.tryPromise({
        try: () =>
          this.db.select().from(commandSessions).where(eq(commandSessions.id, sessionId)).get(),
        catch: (e) => new Error(`Failed to load session: ${e}`),
      });

      if (!session) {
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: "Error: Session expired. Please start over with `/agon agent create`.",
              flags: 64,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      let state: AgentCreateState;
      try {
        state = JSON.parse(session.stateJson as string) as AgentCreateState;
      } catch {
        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: "Error: Invalid session state.",
              flags: 64,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (action === "provider") {
        const provider = interaction.data.values?.[0];
        if (!provider) {
          return new Response(
            JSON.stringify({
              type: 4,
              data: {
                content: "Error: No provider selected.",
                flags: 64,
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        state.provider = provider;

        // Get models for this provider
        const models = yield* this.modelsDev.getModelsByProvider(provider);
        const modelOptions = models.slice(0, 25).map((m) => ({
          label: m.name,
          value: m.id,
          description: m.id,
        }));

        // Add default option
        modelOptions.unshift({
          label: "Default",
          value: "default",
          description: getDefaultModel(provider),
        });

        // Update session
        yield* Effect.tryPromise({
          try: () =>
            this.db
              .update(commandSessions)
              .set({ stateJson: JSON.stringify(state) })
              .where(eq(commandSessions.id, sessionId))
              .run(),
          catch: (e) => new Error(`Failed to update session: ${e}`),
        });

        // Show model selection
        return new Response(
          JSON.stringify({
            type: 7, // UPDATE_MESSAGE
            data: {
              content: `**Create Agent: ${state.name}**\n\nProvider: ${provider}\nStep 3/3: Select a model`,
              components: [
                {
                  type: 1, // Action Row
                  components: [
                    {
                      type: 3, // String Select
                      custom_id: `agon:agent:create:model:${sessionId}`,
                      placeholder: "Choose a model",
                      options: modelOptions,
                    },
                  ],
                },
                {
                  type: 1, // Action Row
                  components: [
                    {
                      type: 2, // Button
                      custom_id: `agon:agent:create:save:${sessionId}`,
                      label: "Save",
                      style: 3, // SUCCESS
                    },
                  ],
                },
              ],
              flags: 64,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (action === "model") {
        const model = interaction.data.values?.[0];
        if (model) {
          if (model === "default") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (state as any).model = undefined;
          } else {
            state.model = model;
          }

          yield* Effect.tryPromise({
            try: () =>
              this.db
                .update(commandSessions)
                .set({ stateJson: JSON.stringify(state) })
                .where(eq(commandSessions.id, sessionId))
                .run(),
            catch: (e) => new Error(`Failed to update session: ${e}`),
          });
        }

        const providerDisplay = state.provider || "openai";
        const modelDisplay = state.model || getDefaultModel(providerDisplay);

        return new Response(
          JSON.stringify({
            type: 4,
            data: {
              content: `**Create Agent: ${state.name}**\n\nProvider: ${providerDisplay}\nModel: ${modelDisplay}\n\nClick **Save** to create the agent.`,
              components: [
                {
                  type: 1, // Action Row
                  components: [
                    {
                      type: 2, // Button
                      custom_id: `agon:agent:create:save:${sessionId}`,
                      label: "Save",
                      style: 3, // SUCCESS
                    },
                  ],
                },
              ],
              flags: 64,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (action === "save") {
        return yield* this.saveAgent(sessionId, state);
      }

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: "Error: Unknown action.",
            flags: 64,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
  }

  /**
   * Save agent to database
   */
  private saveAgent(
    sessionId: string,
    state: AgentCreateState,
  ): Effect.Effect<Response, Error, never> {
    return Effect.gen(this, function* () {
      const provider = state.provider || "openai";
      const model = state.model || getDefaultModel(provider);

      // Generate ID from name
      const id = state.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      // Insert agent
      yield* Effect.tryPromise({
        try: () =>
          this.db
            .insert(agents)
            .values({
              id,
              name: state.name,
              systemPrompt: state.systemPrompt,
              llmProvider: provider as "openai" | "anthropic" | "gemini" | "openrouter",
              llmModel: model,
              temperature: null,
              maxTokens: null,
              thinkingLevel: null,
              thinkingBudgetTokens: null,
            })
            .onConflictDoUpdate({
              target: agents.id,
              set: {
                name: state.name,
                systemPrompt: state.systemPrompt,
                llmProvider: provider as "openai" | "anthropic" | "gemini" | "openrouter",
                llmModel: model,
              },
            })
            .run(),
        catch: (e) => new Error(`Failed to save agent: ${e}`),
      });

      // Delete session
      yield* Effect.tryPromise({
        try: () => this.db.delete(commandSessions).where(eq(commandSessions.id, sessionId)).run(),
        catch: () => new Error("Failed to delete session (ignored)"),
      }).pipe(Effect.catchAll(() => Effect.void));

      return new Response(
        JSON.stringify({
          type: 4,
          data: {
            content: `✅ **Agent created successfully!**\n\n**ID:** ${id}\n**Name:** ${state.name}\n**Provider:** ${provider}\n**Model:** ${model}`,
            flags: 64,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
  }
}

function getDefaultModel(provider: string): string {
  switch (provider) {
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-3-sonnet-20240229";
    case "gemini":
      return "gemini-1.5-flash";
    case "openrouter":
      return "openai/gpt-4o-mini";
    default:
      return "gpt-4o-mini";
  }
}
