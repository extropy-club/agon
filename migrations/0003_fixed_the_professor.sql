ALTER TABLE `rooms` ADD `title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `audience_slot_duration_seconds` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `audience_token_limit` integer DEFAULT 4096 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `room_token_limit` integer DEFAULT 32000 NOT NULL;--> statement-breakpoint
UPDATE `messages` SET `author_type` = 'audience' WHERE `author_type` = 'human';--> statement-breakpoint
UPDATE `messages` SET `author_type` = 'notification' WHERE `author_type` = 'bot_other';