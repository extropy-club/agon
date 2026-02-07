import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Schema } from "effect";
import { agents, commandSessions } from "../d1/schema.js";
import type { ModelInfo, ModelsDevError } from "./ModelsDev.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type AgentCreateState = {
  name: string;
  systemPrompt: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  thinkingBudgetTokens?: number;
};

const SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Provider / model helpers
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { label: "OpenAI", value: "openai", description: "GPT models" },
  { label: "Anthropic", value: "anthropic", description: "Claude models" },
  { label: "Gemini", value: "gemini", description: "Google models" },
  { label: "OpenRouter", value: "openrouter", description: "Multi-provider routing" },
] as const;

const THINKING_LEVELS = [
  { label: "Default (none)", value: "none" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
] as const;

const THINKING_BUDGET_OPTIONS = [
  { label: "Default", value: "default", description: "Use provider default" },
  { label: "1 024 tokens", value: "1024" },
  { label: "2 048 tokens", value: "2048" },
  { label: "4 096 tokens", value: "4096" },
  { label: "8 192 tokens", value: "8192" },
  { label: "16 384 tokens", value: "16384" },
  { label: "32 768 tokens", value: "32768" },
] as const;

function getDefaultModel(provider: string): string {
  switch (provider) {
    case "openai":
      return "gpt-4.1-mini";
    case "anthropic":
      return "claude-sonnet-4-0";
    case "gemini":
      return "gemini-2.5-flash";
    case "openrouter":
      return "openai/gpt-4.1-mini";
    default:
      return "gpt-4.1-mini";
  }
}

// ---------------------------------------------------------------------------
// Service type for ModelsDev dependency
// ---------------------------------------------------------------------------

export type ModelsDevService = {
  readonly fetchModels: () => Effect.Effect<ReadonlyArray<ModelInfo>, ModelsDevError>;
  readonly getModelsByProvider: (
    provider: string,
  ) => Effect.Effect<ReadonlyArray<ModelInfo>, ModelsDevError>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const ephemeralMessage = (content: string) =>
  jsonResponse({ type: 4, data: { content, flags: 64 } });

const ephemeralError = (msg: string) => ephemeralMessage(`Error: ${msg}`);

// ---------------------------------------------------------------------------
// Message builder — renders the "all selects" config message
// ---------------------------------------------------------------------------

function buildConfigMessage(
  sessionId: string,
  state: AgentCreateState,
  modelOptions: Array<{ label: string; value: string; description?: string }>,
  responseType: 4 | 7,
): Response {
  const provider = state.provider || "openai";
  const model = state.model || getDefaultModel(provider);
  const thinkingLevel = state.thinkingLevel || "none";
  const isAnthropic = provider === "anthropic";

  const lines = [
    `**Create Agent: ${state.name}**`,
    "",
    `> Provider: **${provider}** · Model: **${model}**` +
      (thinkingLevel !== "none" ? ` · Thinking: **${thinkingLevel}**` : "") +
      (isAnthropic && state.thinkingBudgetTokens
        ? ` · Budget: **${state.thinkingBudgetTokens}**`
        : ""),
    "",
    "Configure below, then hit **Save**.",
  ];

  // Mark current selection as default in each select
  const providerOptions = PROVIDERS.map((p) => ({
    ...p,
    default: p.value === provider,
  }));

  const modelOpts = modelOptions.map((m) => ({
    ...m,
    default: m.value === (state.model || "default"),
  }));

  const thinkingOpts = THINKING_LEVELS.map((t) => ({
    ...t,
    default: t.value === thinkingLevel,
  }));

  const components: unknown[] = [
    // Row 1: Provider
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `agon:agent:create:provider:${sessionId}`,
          placeholder: "Provider",
          options: providerOptions,
        },
      ],
    },
    // Row 2: Model
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `agon:agent:create:model:${sessionId}`,
          placeholder: "Model",
          options: modelOpts,
        },
      ],
    },
    // Row 3: Thinking level
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `agon:agent:create:thinking:${sessionId}`,
          placeholder: "Thinking level",
          options: thinkingOpts,
        },
      ],
    },
  ];

  // Row 4 (conditional): Thinking budget tokens — Anthropic only
  if (isAnthropic) {
    const budgetValue = state.thinkingBudgetTokens ? String(state.thinkingBudgetTokens) : "default";
    const budgetOpts = THINKING_BUDGET_OPTIONS.map((b) => ({
      ...b,
      default: b.value === budgetValue,
    }));

    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `agon:agent:create:budget:${sessionId}`,
          placeholder: "Thinking budget tokens (Anthropic)",
          options: budgetOpts,
        },
      ],
    });
  }

  // Last row: Save + Cancel
  components.push({
    type: 1,
    components: [
      {
        type: 2,
        custom_id: `agon:agent:create:save:${sessionId}`,
        label: "Save",
        style: 3, // SUCCESS (green)
      },
      {
        type: 2,
        custom_id: `agon:agent:create:cancel:${sessionId}`,
        label: "Cancel",
        style: 4, // DANGER (red)
      },
    ],
  });

  return jsonResponse({
    type: responseType,
    data: {
      content: lines.join("\n"),
      components,
      flags: 64, // EPHEMERAL
    },
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DiscordAgentService {
  constructor(
    private db: DrizzleD1Database,
    private modelsDev: ModelsDevService,
  ) {}

  // ---- Command detection ----------------------------------------------------

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

  static isAgentCreateModalSubmit(interaction: unknown): boolean {
    const result = Schema.decodeUnknownOption(DiscordModalSubmitSchema)(interaction);
    if (result._tag === "None") return false;
    return result.value.data.custom_id === "agon:agent:create:modal";
  }

  static isAgentCreateComponent(interaction: unknown): boolean {
    const result = Schema.decodeUnknownOption(DiscordComponentInteractionSchema)(interaction);
    if (result._tag === "None") return false;
    return result.value.data.custom_id.startsWith("agon:agent:create:");
  }

  // ---- Step 1: Open modal ---------------------------------------------------

  handleAgentCreateModal(_interaction: DiscordAgentCommand): Effect.Effect<Response, never, never> {
    return Effect.succeed(
      jsonResponse({
        type: 9, // MODAL
        data: {
          custom_id: "agon:agent:create:modal",
          title: "Create New Agent",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "agent_name",
                  label: "Agent Name",
                  style: 1,
                  required: true,
                  max_length: 100,
                  placeholder: "e.g., Debate Moderator",
                },
              ],
            },
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "system_prompt",
                  label: "System Prompt",
                  style: 2,
                  required: true,
                  max_length: 4000,
                  placeholder: "Describe the agent's personality and role...",
                },
              ],
            },
          ],
        },
      }),
    );
  }

  // ---- Step 2: Modal submitted → show all-in-one config message -------------

  handleModalSubmit(interaction: DiscordModalSubmit): Effect.Effect<Response, Error, never> {
    return Effect.gen(this, function* () {
      const name =
        interaction.data.components[0]?.components.find((c) => c.custom_id === "agent_name")
          ?.value || "";
      const systemPrompt =
        interaction.data.components[1]?.components.find((c) => c.custom_id === "system_prompt")
          ?.value || "";

      if (!name || !systemPrompt) {
        return ephemeralError("Missing required fields.");
      }

      const sessionId = crypto.randomUUID();
      const now = Date.now();
      const state: AgentCreateState = { name, systemPrompt };

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

      const modelOptions = yield* this.getModelOptions(state.provider || "openai");

      return buildConfigMessage(sessionId, state, modelOptions, 4);
    });
  }

  // ---- Component interactions (selects + buttons) ---------------------------

  handleComponentInteraction(
    interaction: DiscordComponentInteraction,
  ): Effect.Effect<Response, Error, never> {
    return Effect.gen(this, function* () {
      const customId = interaction.data.custom_id;
      const parts = customId.split(":");
      // agon:agent:create:<action>:<sessionId>
      const action = parts[3];
      const sessionId = parts[4];

      if (!sessionId) return ephemeralError("Malformed interaction.");

      // Cancel — just delete session and acknowledge
      if (action === "cancel") {
        yield* Effect.tryPromise({
          try: () => this.db.delete(commandSessions).where(eq(commandSessions.id, sessionId)).run(),
          catch: () => new Error("ignored"),
        }).pipe(Effect.catchAll(() => Effect.void));

        return jsonResponse({
          type: 7,
          data: { content: "❌ Agent creation cancelled.", components: [], flags: 64 },
        });
      }

      // Load session (enforce expiry)
      const session = yield* Effect.tryPromise({
        try: () =>
          this.db.select().from(commandSessions).where(eq(commandSessions.id, sessionId)).get(),
        catch: (e) => new Error(`Failed to load session: ${e}`),
      });

      if (!session || session.expiresAtMs < Date.now()) {
        if (session) {
          yield* Effect.tryPromise({
            try: () =>
              this.db.delete(commandSessions).where(eq(commandSessions.id, sessionId)).run(),
            catch: () => new Error("ignored"),
          }).pipe(Effect.catchAll(() => Effect.void));
        }
        return ephemeralError("Session expired. Please start over with `/agon agent create`.");
      }

      let state: AgentCreateState;
      try {
        state = JSON.parse(session.stateJson as string) as AgentCreateState;
      } catch {
        return ephemeralError("Invalid session state.");
      }

      // Handle each select / button
      const value = interaction.data.values?.[0];

      if (action === "provider" && value) {
        state.provider = value;
        // Reset model when provider changes
        delete state.model;
        // Reset Anthropic-specific budget when switching away
        if (value !== "anthropic") {
          delete state.thinkingBudgetTokens;
        }
      } else if (action === "model" && value) {
        if (value === "default") delete state.model;
        else state.model = value;
      } else if (action === "thinking" && value) {
        if (value === "none") delete state.thinkingLevel;
        else state.thinkingLevel = value;
      } else if (action === "budget" && value) {
        if (value === "default") delete state.thinkingBudgetTokens;
        else {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) state.thinkingBudgetTokens = n;
        }
      } else if (action === "save") {
        return yield* this.saveAgent(sessionId, state);
      }

      // Persist state
      yield* Effect.tryPromise({
        try: () =>
          this.db
            .update(commandSessions)
            .set({ stateJson: JSON.stringify(state) })
            .where(eq(commandSessions.id, sessionId))
            .run(),
        catch: (e) => new Error(`Failed to update session: ${e}`),
      });

      // Re-render config message (type 7 = UPDATE_MESSAGE)
      const modelOptions = yield* this.getModelOptions(state.provider || "openai");
      return buildConfigMessage(sessionId, state, modelOptions, 7);
    });
  }

  // ---- Helpers --------------------------------------------------------------

  private getModelOptions(
    provider: string,
  ): Effect.Effect<Array<{ label: string; value: string; description: string }>, Error, never> {
    return this.modelsDev.getModelsByProvider(provider).pipe(
      Effect.map((models) => {
        const options = models.slice(0, 24).map((m) => ({
          label: m.name.length > 100 ? m.name.slice(0, 97) + "..." : m.name,
          value: m.id,
          description: m.id.length > 100 ? m.id.slice(0, 97) + "..." : m.id,
        }));
        options.unshift({
          label: "Default",
          value: "default",
          description: getDefaultModel(provider),
        });
        return options;
      }),
      Effect.catchAll(
        () =>
          Effect.succeed([
            { label: "Default", value: "default", description: getDefaultModel(provider) },
          ]) as Effect.Effect<Array<{ label: string; value: string; description: string }>>,
      ),
    );
  }

  private saveAgent(
    sessionId: string,
    state: AgentCreateState,
  ): Effect.Effect<Response, Error, never> {
    return Effect.gen(this, function* () {
      const provider = state.provider || "openai";
      const model = state.model || getDefaultModel(provider);
      const thinkingLevel = state.thinkingLevel as "low" | "medium" | "high" | undefined;

      const id = state.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

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
              thinkingLevel: thinkingLevel ?? null,
              thinkingBudgetTokens: state.thinkingBudgetTokens ?? null,
            })
            .onConflictDoUpdate({
              target: agents.id,
              set: {
                name: state.name,
                systemPrompt: state.systemPrompt,
                llmProvider: provider as "openai" | "anthropic" | "gemini" | "openrouter",
                llmModel: model,
                thinkingLevel: thinkingLevel ?? null,
                thinkingBudgetTokens: state.thinkingBudgetTokens ?? null,
              },
            })
            .run(),
        catch: (e) => new Error(`Failed to save agent: ${e}`),
      });

      // Clean up session
      yield* Effect.tryPromise({
        try: () => this.db.delete(commandSessions).where(eq(commandSessions.id, sessionId)).run(),
        catch: () => new Error("ignored"),
      }).pipe(Effect.catchAll(() => Effect.void));

      const lines = [
        "✅ **Agent created!**",
        "",
        `**ID:** ${id}`,
        `**Name:** ${state.name}`,
        `**Provider:** ${provider}`,
        `**Model:** ${model}`,
        ...(thinkingLevel ? [`**Thinking:** ${thinkingLevel}`] : []),
        ...(state.thinkingBudgetTokens
          ? [`**Thinking budget:** ${state.thinkingBudgetTokens} tokens`]
          : []),
      ];

      return jsonResponse({
        type: 7, // UPDATE_MESSAGE — replace the config message
        data: { content: lines.join("\n"), components: [], flags: 64 },
      });
    });
  }
}
