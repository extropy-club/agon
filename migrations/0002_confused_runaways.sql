CREATE TABLE `room_turn_events` (
	`room_id` integer NOT NULL,
	`turn_number` integer NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`data_json` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
