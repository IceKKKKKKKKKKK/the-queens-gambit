CREATE TABLE `room_creation_limits` (
	`key_hash` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `games_expires_at_idx` ON `games` (`expires_at`);