CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`room_id` integer NOT NULL,
	`content` text NOT NULL,
	`created_by` text DEFAULT 'agent' NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `rooms` ADD `summary_md` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `summary_updated_at_ms` integer;
--> statement-breakpoint

-- FTS5 virtual table for full-text search on memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content=memories, content_rowid=rowid);
--> statement-breakpoint

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_memories_agent_created ON memories(agent_id, created_at_ms DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_memories_room ON memories(room_id);
