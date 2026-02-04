import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  systemPrompt: text("system_prompt").notNull(),
  llmProvider: text("llm_provider", { enum: ["openai", "anthropic", "gemini"] })
    .notNull()
    .default("openai"),
  llmModel: text("llm_model").notNull().default("gpt-4o-mini"),
});

export const rooms = sqliteTable("rooms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status", { enum: ["active", "paused"] }).notNull(),
  topic: text("topic").notNull(),
  parentChannelId: text("parent_channel_id").notNull(),
  threadId: text("thread_id").notNull().unique(),
  autoArchiveDurationMinutes: integer("auto_archive_duration_minutes").notNull().default(1440),
  currentTurnAgentId: text("current_turn_agent_id").notNull(),
  currentTurnNumber: integer("current_turn_number").notNull().default(0),
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
  authorType: text("author_type", { enum: ["human", "agent", "bot_other"] }).notNull(),
  authorAgentId: text("author_agent_id"),
  content: text("content").notNull(),
  // store unix epoch millis
  createdAtMs: integer("created_at_ms").notNull(),
});
