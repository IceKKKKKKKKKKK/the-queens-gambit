CREATE TABLE `friendships` (
	`id` text PRIMARY KEY NOT NULL,
	`user_low_id` text NOT NULL,
	`user_high_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `friendships_pair_idx` ON `friendships` (`user_low_id`,`user_high_id`);--> statement-breakpoint
CREATE INDEX `friendships_low_status_idx` ON `friendships` (`user_low_id`,`status`);--> statement-breakpoint
CREATE INDEX `friendships_high_status_idx` ON `friendships` (`user_high_id`,`status`);--> statement-breakpoint
CREATE TABLE `matchmaking_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`lease_until` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `matchmaking_queue` (
	`user_id` text PRIMARY KEY NOT NULL,
	`ticket` text NOT NULL,
	`mode` text NOT NULL,
	`rating` integer NOT NULL,
	`status` text NOT NULL,
	`match_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matchmaking_queue_ticket_idx` ON `matchmaking_queue` (`ticket`);--> statement-breakpoint
CREATE INDEX `matchmaking_queue_mode_status_created_idx` ON `matchmaking_queue` (`mode`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `platform_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`ranked` integer DEFAULT true NOT NULL,
	`status` text NOT NULL,
	`player_a_id` text NOT NULL,
	`player_b_id` text NOT NULL,
	`winner_user_id` text,
	`ended_reason` text,
	`rating_before_a` integer NOT NULL,
	`rating_before_b` integer NOT NULL,
	`rating_delta_a` integer,
	`rating_delta_b` integer,
	`game_code` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `platform_matches_player_a_completed_idx` ON `platform_matches` (`player_a_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `platform_matches_player_b_completed_idx` ON `platform_matches` (`player_b_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `platform_matches_status_created_idx` ON `platform_matches` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `platform_users` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_user_id` text NOT NULL,
	`email` text NOT NULL,
	`handle` text NOT NULL,
	`handle_key` text NOT NULL,
	`rating` integer DEFAULT 1200 NOT NULL,
	`ranked_games` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`losses` integer DEFAULT 0 NOT NULL,
	`draws` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_users_auth_user_id_idx` ON `platform_users` (`auth_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_users_handle_key_idx` ON `platform_users` (`handle_key`);--> statement-breakpoint
CREATE TABLE `player_presence` (
	`user_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`current_match_id` text,
	`last_heartbeat_at` integer NOT NULL
);
