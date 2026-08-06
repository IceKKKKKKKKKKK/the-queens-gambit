CREATE TABLE `games` (
	`code` text PRIMARY KEY NOT NULL,
	`black_token_hash` text NOT NULL,
	`white_token_hash` text NOT NULL,
	`white_invite_hash` text NOT NULL,
	`state_json` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
