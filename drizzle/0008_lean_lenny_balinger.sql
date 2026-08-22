CREATE TABLE `training_sync_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_key` text NOT NULL,
	`employee_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`operation` text DEFAULT 'install' NOT NULL,
	`assignment_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'failed' NOT NULL,
	`manifest_version` text,
	`source_hash` text,
	`verified_hash` text,
	`evidence` text DEFAULT '' NOT NULL,
	`worker_id` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`verified_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_training_sync_event_key` ON `training_sync_history` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_training_sync_employee_skill` ON `training_sync_history` (`employee_id`,`skill_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_training_sync_status_updated` ON `training_sync_history` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `employee_skills` ADD `desired_state` text DEFAULT 'assigned' NOT NULL;--> statement-breakpoint
ALTER TABLE `employee_skills` ADD `assignment_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `employee_skills` ADD `updated_at` text;--> statement-breakpoint
UPDATE `employee_skills` SET `updated_at` = COALESCE(`assigned_at`, CURRENT_TIMESTAMP);
