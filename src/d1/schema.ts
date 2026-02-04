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
  thinkingLevel: text("thinking_level", {
    enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
  }),
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
  currentTurnAgentId: text("current_turn_agent_id").notNull(),
  currentTurnNumber: integer("current_turn_number").notNull().default(0),
  lastEnqueuedTurnNumber: integer("last_enqueued_turn_number").notNull().default(0),
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
  // store unix epoch millis
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
