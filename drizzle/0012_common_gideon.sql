CREATE TABLE `character_upload_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`original_filename` text,
	`total_chunks` integer,
	`expected_size` integer,
	`imported_character_id` text,
	`expires_at` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "character_upload_sessions_status_check" CHECK("character_upload_sessions"."status" IN ('uploading', 'completed')),
	CONSTRAINT "character_upload_sessions_completion_check" CHECK(
      "character_upload_sessions"."status" = 'uploading' OR (
        "character_upload_sessions"."imported_character_id" IS NOT NULL AND "character_upload_sessions"."original_filename" IS NOT NULL
        AND "character_upload_sessions"."total_chunks" IS NOT NULL AND "character_upload_sessions"."expected_size" IS NOT NULL
        AND "character_upload_sessions"."completed_at" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE INDEX `idx_character_upload_sessions_expiry` ON `character_upload_sessions` (`expires_at`,`status`);