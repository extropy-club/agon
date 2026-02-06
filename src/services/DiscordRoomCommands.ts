import { asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { Effect, Schema } from "effect";
import { agents, commandSessions, discordChannels } from "../d1/schema.js";
import { ArenaService, type TurnJob } from "./ArenaService.js";
import { Discord, type DiscordAutoArchiveDurationMinutes } from "./Discord.js";

// ---------------------------------------------------------------------------
// Schemas (re-export the shared ones from DiscordAgentCommands for convenience)
// ---------------------------------------------------------------------------

export const RoomCommandSchema = Schema.Struct({
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

export const RoomModalSubmitSchema = Schema.Struct({
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

export type RoomModalSubmit = typeof RoomModalSubmitSchema.Type;

export const RoomComponentSchema = Schema.Struct({
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

export type RoomComponent = typeof RoomComponentSchema.Type;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type RoomCreateState = {
  title: string;
  topic: string;
  parentChannelId: string;
  agentIds?: string[];
  maxTurns?: number;
  audienceSlotDurationSeconds?: number;
  autoArchiveDurationMinutes?: number;
};

// ---------------------------------------------------------------------------
// Return type — index.ts needs to enqueue the first job
// ---------------------------------------------------------------------------

export type RoomInteractionResult = {
  readonly response: Response;
  readonly enqueue?: TurnJob | undefined;
};

const SESSION_EXPIRY_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Select option presets
// ---------------------------------------------------------------------------

const MAX_TURNS_OPTIONS = [
  { label: "10 turns", value: "10" },
  { label: "20 turns", value: "20" },
  { label: "30 turns (default)", value: "30" },
  { label: "50 turns", value: "50" },
  { label: "100 turns", value: "100" },
  { label: "Unlimited (999)", value: "999" },
] as const;

const AUDIENCE_SLOT_OPTIONS = [
  { label: "Off (0s)", value: "0" },
  { label: "30 seconds (default)", value: "30" },
  { label: "60 seconds", value: "60" },
  { label: "2 minutes", value: "120" },
  { label: "5 minutes", value: "300" },
] as const;

const AUTO_ARCHIVE_OPTIONS = [
  { label: "1 hour", value: "60" },
  { label: "24 hours (default)", value: "1440" },
  { label: "3 days", value: "4320" },
  { label: "7 days", value: "10080" },
] as const;

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

const result = (response: Response, enqueue?: TurnJob): RoomInteractionResult =>
  enqueue ? { response, enqueue } : { response };

// ---------------------------------------------------------------------------
// Config message builder
// ---------------------------------------------------------------------------

function buildConfigMessage(
  sessionId: string,
  state: RoomCreateState,
  agentOptions: Array<{ label: string; value: string; description?: string }>,
  responseType: 4 | 7,
): Response {
  const maxTurns = state.maxTurns ?? 30;
  const audienceSlot = state.audienceSlotDurationSeconds ?? 30;
  const autoArchive = state.autoArchiveDurationMinutes ?? 1440;
  const selectedAgents = state.agentIds ?? [];

  const lines = [
    `**Create Room${state.title ? `: ${state.title}` : ""}**`,
    "",
    `> Agents: **${selectedAgents.length > 0 ? selectedAgents.join(", ") : "none selected"}**`,
    `> Max turns: **${maxTurns}** · Audience slot: **${audienceSlot}s** · Auto-archive: **${autoArchive}m**`,
    "",
    selectedAgents.length < 2 ? "⚠️ Select at least 2 agents to start." : "Configure below, then hit **Start**.",
  ];

  const maxTurnsOpts = MAX_TURNS_OPTIONS.map((o) => ({
    ...o,
    default: o.value === String(maxTurns),
  }));

  const audienceOpts = AUDIENCE_SLOT_OPTIONS.map((o) => ({
    ...o,
    default: o.value === String(audienceSlot),
  }));

  const archiveOpts = AUTO_ARCHIVE_OPTIONS.map((o) => ({
    ...o,
    default: o.value === String(autoArchive),
  }));

  // Mark selected agents
  const agentOpts = agentOptions.map((a) => ({
    ...a,
    default: selectedAgents.includes(a.value),
  }));

  const components: unknown[] = [
    // Row 1: Agent multi-select
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `agon:room:create:agents:${sessionId}`,
          placeholder: "Select agents (min 2)",
          min_values: 2,
          max_values: Math.min(agentOpts.length, 25),
          options: agentOpts,
        },
      ],
    },
    // Row 2: Max turns
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `agon:room:create:maxturns:${sessionId}`,
          placeholder: "Max turns",
          options: maxTurnsOpts,
        },
      ],
    },
    // Row 3: Audience slot duration
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `agon:room:create:audience:${sessionId}`,
          placeholder: "Audience slot duration",
          options: audienceOpts,
        },
      ],
    },
    // Row 4: Auto-archive
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `agon:room:create:archive:${sessionId}`,
          placeholder: "Auto-archive after",
          options: archiveOpts,
        },
      ],
    },
    // Row 5: Start + Cancel
    {
      type: 1,
      components: [
        {
          type: 2,
          custom_id: `agon:room:create:start:${sessionId}`,
          label: "Start",
          style: 3, // SUCCESS
          disabled: selectedAgents.length < 2,
        },
        {
          type: 2,
          custom_id: `agon:room:create:cancel:${sessionId}`,
          label: "Cancel",
          style: 4, // DANGER
        },
      ],
    },
  ];

  return jsonResponse({
    type: responseType,
    data: { content: lines.join("\n"), components, flags: 64 },
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DiscordRoomService {
  constructor(
    private db: DrizzleD1Database,
    private discord: Discord extends { Type: infer T } ? T : never,
    private arena: ArenaService extends { Type: infer T } ? T : never,
  ) {}

  // ---- Detection -----------------------------------------------------------

  static isRoomCreateCommand(interaction: unknown): boolean {
    const res = Schema.decodeUnknownOption(RoomCommandSchema)(interaction);
    if (res._tag === "None") return false;

    const cmd = res.value;
    if (cmd.data.name !== "agon") return false;

    const roomGroup = cmd.data.options?.find((o) => o.name === "room");
    if (!roomGroup) return false;

    const createCmd = roomGroup.options?.find((o: unknown) => {
      const opt = o as { name: string; type: number };
      return opt.name === "create" && opt.type === 1;
    });

    return !!createCmd;
  }

  static isRoomCreateModalSubmit(interaction: unknown): boolean {
    const res = Schema.decodeUnknownOption(RoomModalSubmitSchema)(interaction);
    if (res._tag === "None") return false;
    return res.value.data.custom_id === "agon:room:create:modal";
  }

  static isRoomCreateComponent(interaction: unknown): boolean {
    const res = Schema.decodeUnknownOption(RoomComponentSchema)(interaction);
    if (res._tag === "None") return false;
    return res.value.data.custom_id.startsWith("agon:room:create:");
  }

  // ---- Step 1: Modal -------------------------------------------------------

  handleRoomCreateModal(): Effect.Effect<Response, never, never> {
    return Effect.succeed(
      jsonResponse({
        type: 9, // MODAL
        data: {
          custom_id: "agon:room:create:modal",
          title: "Create Debate Room",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "room_title",
                  label: "Title (also used as thread name)",
                  style: 1, // SHORT
                  required: false,
                  max_length: 100,
                  placeholder: "e.g., AI Ethics Debate",
                },
              ],
            },
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "room_topic",
                  label: "Debate Topic",
                  style: 2, // PARAGRAPH
                  required: true,
                  max_length: 4000,
                  placeholder: "Describe the topic the agents should debate...",
                },
              ],
            },
          ],
        },
      }),
    );
  }

  // ---- Step 2: Modal submitted → config message ----------------------------

  handleModalSubmit(interaction: RoomModalSubmit): Effect.Effect<RoomInteractionResult, Error, never> {
    return Effect.gen(this, function* () {
      const title =
        interaction.data.components[0]?.components.find((c) => c.custom_id === "room_title")
          ?.value || "";
      const topic =
        interaction.data.components[1]?.components.find((c) => c.custom_id === "room_topic")
          ?.value || "";

      if (!topic) {
        return result(ephemeralError("Topic is required."));
      }

      const parentChannelId = interaction.channel_id;

      const sessionId = crypto.randomUUID();
      const now = Date.now();
      const state: RoomCreateState = { title, topic, parentChannelId };

      yield* Effect.tryPromise({
        try: () =>
          this.db
            .insert(commandSessions)
            .values({
              id: sessionId,
              kind: "room_create",
              userId: interaction.member.user.id,
              stateJson: JSON.stringify(state),
              createdAtMs: now,
              expiresAtMs: now + SESSION_EXPIRY_MS,
            })
            .run(),
        catch: (e): Error => new Error(`Failed to create session: ${e}`),
      });

      const agentOptions = yield* this.getAgentOptions();

      if (agentOptions.length < 2) {
        return result(
          ephemeralError(
            "Need at least 2 agents to create a room. Create agents first with `/agon agent create`.",
          ),
        );
      }

      return result(buildConfigMessage(sessionId, state, agentOptions, 4));
    });
  }

  // ---- Component interactions ----------------------------------------------

  handleComponentInteraction(
    interaction: RoomComponent,
  ): Effect.Effect<RoomInteractionResult, Error, never> {
    return Effect.gen(this, function* () {
      const customId = interaction.data.custom_id;
      const parts = customId.split(":");
      // agon:room:create:<action>:<sessionId>
      const action = parts[3];
      const sessionId = parts[4];

      if (!sessionId) return result(ephemeralError("Malformed interaction."));

      // Cancel
      if (action === "cancel") {
        yield* Effect.tryPromise({
          try: () =>
            this.db.delete(commandSessions).where(eq(commandSessions.id, sessionId)).run(),
          catch: () => new Error("ignored"),
        }).pipe(Effect.catchAll(() => Effect.void));

        return result(
          jsonResponse({
            type: 7,
            data: { content: "❌ Room creation cancelled.", components: [], flags: 64 },
          }),
        );
      }

      // Load session
      const session = yield* Effect.tryPromise({
        try: () =>
          this.db.select().from(commandSessions).where(eq(commandSessions.id, sessionId)).get(),
        catch: (e) => new Error(`Failed to load session: ${e}`),
      });

      if (!session) {
        return result(
          ephemeralError("Session expired. Please start over with `/agon room create`."),
        );
      }

      let state: RoomCreateState;
      try {
        state = JSON.parse(session.stateJson as string) as RoomCreateState;
      } catch {
        return result(ephemeralError("Invalid session state."));
      }

      const values = interaction.data.values;

      if (action === "agents" && values && values.length > 0) {
        state.agentIds = [...values];
      } else if (action === "maxturns" && values?.[0]) {
        state.maxTurns = Number(values[0]);
      } else if (action === "audience" && values?.[0]) {
        state.audienceSlotDurationSeconds = Number(values[0]);
      } else if (action === "archive" && values?.[0]) {
        state.autoArchiveDurationMinutes = Number(values[0]);
      } else if (action === "start") {
        return yield* this.startRoom(sessionId, state);
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

      // Re-render
      const agentOptions = yield* this.getAgentOptions();
      return result(buildConfigMessage(sessionId, state, agentOptions, 7));
    });
  }

  // ---- Helpers -------------------------------------------------------------

  private getAgentOptions(): Effect.Effect<
    Array<{ label: string; value: string; description: string }>,
    Error,
    never
  > {
    return Effect.tryPromise({
      try: () => this.db.select().from(agents).orderBy(asc(agents.name)).all(),
      catch: (e): Error => new Error(`Failed to load agents: ${e}`),
    }).pipe(
      Effect.map((rows) =>
        rows.slice(0, 25).map((a) => ({
          label: a.name.length > 100 ? a.name.slice(0, 97) + "..." : a.name,
          value: a.id,
          description:
            `${a.llmProvider}/${a.llmModel}`.length > 100
              ? `${a.llmProvider}/${a.llmModel}`.slice(0, 97) + "..."
              : `${a.llmProvider}/${a.llmModel}`,
        })),
      ),
    );
  }

  private startRoom(
    sessionId: string,
    state: RoomCreateState,
  ): Effect.Effect<RoomInteractionResult, Error, never> {
    return Effect.gen(this, function* () {
      const agentIds = state.agentIds;
      if (!agentIds || agentIds.length < 2) {
        return result(ephemeralError("Select at least 2 agents."));
      }

      const parentChannelId = state.parentChannelId;
      const autoArchiveMinutes = state.autoArchiveDurationMinutes ?? 1440;

      const allowed = [60, 1440, 4320, 10080] as const;
      const autoArchiveDurationMinutes = allowed.includes(
        autoArchiveMinutes as (typeof allowed)[number],
      )
        ? (autoArchiveMinutes as DiscordAutoArchiveDurationMinutes)
        : (1440 as DiscordAutoArchiveDurationMinutes);

      // Ensure webhook for parent channel
      const existingWebhook = yield* Effect.tryPromise({
        try: () =>
          this.db
            .select()
            .from(discordChannels)
            .where(eq(discordChannels.channelId, parentChannelId))
            .get(),
        catch: (e): Error => new Error(`DB error: ${e}`),
      });

      const webhook = existingWebhook
        ? { id: existingWebhook.webhookId, token: existingWebhook.webhookToken }
        : yield* this.discord.createOrFetchWebhook(parentChannelId).pipe(
            Effect.mapError((e) => new Error(`Discord webhook error: ${String(e)}`)),
          );

      yield* Effect.tryPromise({
        try: () =>
          this.db
            .insert(discordChannels)
            .values({
              channelId: parentChannelId,
              webhookId: webhook.id,
              webhookToken: webhook.token,
            })
            .onConflictDoUpdate({
              target: discordChannels.channelId,
              set: { webhookId: webhook.id, webhookToken: webhook.token },
            })
            .run(),
        catch: (e): Error => new Error(`DB error: ${e}`),
      });

      // Create Discord thread
      const threadName =
        state.title.trim().length > 0
          ? state.title.trim()
          : `Agon Room ${new Date().toISOString()}`;

      const threadId = yield* this.discord
        .createPublicThread(parentChannelId, {
          name: threadName,
          autoArchiveDurationMinutes,
        })
        .pipe(Effect.mapError((e) => new Error(`Discord thread error: ${String(e)}`)));

      // Create room
      const roomResult = yield* this.arena
        .createRoom({
          parentChannelId,
          threadId,
          topic: state.topic,
          autoArchiveDurationMinutes,
          agentIds,
          ...(state.title.trim().length > 0 ? { title: state.title.trim() } : {}),
          ...(state.audienceSlotDurationSeconds !== undefined
            ? { audienceSlotDurationSeconds: state.audienceSlotDurationSeconds }
            : {}),
          ...(state.maxTurns !== undefined ? { maxTurns: state.maxTurns } : {}),
        })
        .pipe(Effect.mapError((e) => new Error(`Arena error: ${String(e)}`)));

      // Clean up session
      yield* Effect.tryPromise({
        try: () => this.db.delete(commandSessions).where(eq(commandSessions.id, sessionId)).run(),
        catch: () => new Error("ignored"),
      }).pipe(Effect.catchAll(() => Effect.void));

      const lines = [
        "🚀 **Room created!**",
        "",
        `**Thread:** <#${threadId}>`,
        ...(state.title ? [`**Title:** ${state.title}`] : []),
        `**Agents:** ${agentIds.join(", ")}`,
        `**Max turns:** ${state.maxTurns ?? 30}`,
        `**Audience slot:** ${state.audienceSlotDurationSeconds ?? 30}s`,
      ];

      return result(
        jsonResponse({
          type: 7,
          data: { content: lines.join("\n"), components: [], flags: 64 },
        }),
        roomResult.firstJob,
      );
    });
  }
}
