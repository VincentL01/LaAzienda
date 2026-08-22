CREATE TABLE `owner_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner_verifier` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_owner_sessions_expiry` ON `owner_sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `character_upload_sessions` ADD `pending_key_root` text;--> statement-breakpoint
ALTER TABLE `character_upload_sessions` ADD `pending_archive_digest` text;--> statement-breakpoint
ALTER TABLE `character_upload_sessions` ADD `pending_sprite_key` text;--> statement-breakpoint
ALTER TABLE `character_upload_sessions` ADD `cleanup_claimed_at` text;