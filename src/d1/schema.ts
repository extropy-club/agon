import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  systemPrompt: text("system_prompt").notNull(),
  llmProvider: text("llm_provider", { enum: ["openai", "anthropic", "gemini", "openrouter"] })
    .notNull()
    .default("openai"),
  llmModel: text("llm_model").notNull().default("gpt-4o-mini"),

  // Optional per-agent generation params (null => provider defaults)
  temperature: text("temperature"),
  maxTokens: integer("max_tokens"),
  // Provider-native values stored directly:
  // OpenAI/OpenRouter: none | minimal | low | medium | high
  // Gemini 3: LOW | HIGH
  // Anthropic: uses thinkingBudgetTokens instead
  thinkingLevel: text("thinking_level"),
  thinkingBudgetTokens: integer("thinking_budget_tokens"),
});

export const rooms = sqliteTable("rooms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status", { enum: ["active", "paused", "audience_slot"] }).notNull(),
  topic: text("topic").notNull(),
  title: text("title").notNull().default(""),
  parentChannelId: text("parent_channel_id").notNull(),
  threadId: text("thread_id").notNull().unique(),
  autoArchiveDurationMinutes: integer("auto_archive_duration_minutes").notNull().default(1440),
  audienceSlotDurationSeconds: integer("audience_slot_duration_seconds").notNull().default(30),
  audienceTokenLimit: integer("audience_token_limit").notNull().default(4096),
  roomTokenLimit: integer("room_token_limit").notNull().default(32000),
  maxTurns: integer("max_turns").notNull().default(30),
  currentTurnAgentId: text("current_turn_agent_id").notNull(),
  currentTurnNumber: integer("current_turn_number").notNull().default(0),
  lastEnqueuedTurnNumber: integer("last_enqueued_turn_number").notNull().default(0),

  // Room summary (generated periodically for long threads)
  summaryMd: text("summary_md"),
  summaryUpdatedAtMs: integer("summary_updated_at_ms"),
});

export const roomAgents = sqliteTable("room_agents", {
  roomId: integer("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  turnOrder: integer("turn_order").notNull(),
});

export const discordChannels = sqliteTable("discord_channels", {
  channelId: text("channel_id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  webhookToken: text("webhook_token").notNull(),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: integer("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  discordMessageId: text("discord_message_id").notNull().unique(),
  threadId: text("thread_id").notNull(),
  authorType: text("author_type", {
    enum: ["moderator", "agent", "audience", "notification"],
  }).notNull(),
  authorAgentId: text("author_agent_id"),
  /**
   * Optional explicit author name (e.g. audience username, or "System" for notifications).
   */
  authorName: text("author_name"),
  content: text("content").notNull(),
  /**
   * Reasoning / thinking text, when the provider exposes it.
   *
   * NOTE: stored separately from `content` so we can keep message content clean.
   */
  thinkingText: text("thinking_text"),
  /** Prompt tokens (when available). */
  inputTokens: integer("input_tokens"),
  /** Completion tokens (when available). */
  outputTokens: integer("output_tokens"),
  // store unix epoch millis
  createdAtMs: integer("created_at_ms").notNull(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(), // UUID
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  roomId: integer("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdBy: text("created_by", { enum: ["agent", "auto"] })
    .notNull()
    .default("agent"),
  createdAtMs: integer("created_at_ms").notNull(),
});

/**
 * Minimal turn lifecycle telemetry for debugging.
 *
 * NOTE: no primary key; SQLite rowid can be used implicitly.
 */
export const roomTurnEvents = sqliteTable("room_turn_events", {
  roomId: integer("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  turnNumber: integer("turn_number").notNull(),
  phase: text("phase").notNull(),
  status: text("status").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  dataJson: text("data_json"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

/**
 * Command session state for multi-step Discord slash command flows.
 */
export const commandSessions = sqliteTable("command_sessions", {
  id: text("id").primaryKey(),
  kind: text("kind", {
    enum: ["agent_create", "agent_delete", "room_create"],
  }).notNull(),
  userId: text("user_id").notNull(),
  stateJson: text("state_json").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
});
