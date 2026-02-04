CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`system_prompt` text NOT NULL,
	`llm_provider` text DEFAULT 'openai' NOT NULL,
	`llm_model` text DEFAULT 'gpt-4o-mini' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discord_channels` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`webhook_token` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` integer NOT NULL,
	`discord_message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_agent_id` text,
	`content` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_discord_message_id_unique` ON `messages` (`discord_message_id`);--> statement-breakpoint
CREATE TABLE `room_agents` (
	`room_id` integer NOT NULL,
	`agent_id` text NOT NULL,
	`turn_order` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`topic` text NOT NULL,
	`parent_channel_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`auto_archive_duration_minutes` integer DEFAULT 1440 NOT NULL,
	`current_turn_agent_id` text NOT NULL,
	`current_turn_number` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_thread_id_unique` ON `rooms` (`thread_id`);