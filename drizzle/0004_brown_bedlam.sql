ALTER TABLE `games` ADD `room_kind` text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `game_mode` text DEFAULT 'classic' NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `spectator_policy` text DEFAULT 'hidden' NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `black_user_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `white_user_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `match_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `games` ADD `result_recorded` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `games_match_id_idx` ON `games` (`match_id`);
