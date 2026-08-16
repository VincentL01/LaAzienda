CREATE TABLE `repository_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`branch` text NOT NULL,
	`source_branch` text NOT NULL,
	`commit_sha` text NOT NULL,
	`pull_number` integer,
	`synced_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repository_syncs_commit` ON `repository_syncs` (`repository`,`commit_sha`);--> statement-breakpoint
CREATE INDEX `idx_repository_syncs_synced_at` ON `repository_syncs` (`synced_at`);