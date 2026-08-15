CREATE TABLE `character_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source_url` text,
	`install_command` text,
	`spritesheet_path` text,
	`sprite_version` integer DEFAULT 1 NOT NULL,
	`cache_status` text DEFAULT 'requested' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`cached_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_character_packs_cache_status` ON `character_packs` (`cache_status`);--> statement-breakpoint
CREATE TABLE `employee_skills` (
	`employee_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`assigned_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`employee_id`, `skill_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_employee_skills_skill` ON `employee_skills` (`skill_id`);--> statement-breakpoint
CREATE TABLE `runtime_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_key` text NOT NULL,
	`employee_id` text NOT NULL,
	`container_status` text NOT NULL,
	`employee_status` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runtime_events_event_key` ON `runtime_events` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_runtime_events_employee_created` ON `runtime_events` (`employee_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `training_center_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`package_ref` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source_url` text,
	`install_command` text NOT NULL,
	`cache_status` text DEFAULT 'requested' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`cached_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_training_skills_package_ref` ON `training_center_skills` (`package_ref`);--> statement-breakpoint
CREATE TABLE `__new_employees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`department` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`pet_id` text NOT NULL,
	`system_prompt` text DEFAULT '' NOT NULL,
	`container_name` text,
	`desired_runtime_status` text DEFAULT 'stopped' NOT NULL,
	`runtime_status` text DEFAULT 'not_provisioned' NOT NULL,
	`last_runtime_at` text,
	`current_task_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_employees` (
	`id`, `name`, `role`, `department`, `status`, `pet_id`, `system_prompt`,
	`container_name`, `desired_runtime_status`, `runtime_status`, `last_runtime_at`,
	`current_task_id`, `created_at`, `updated_at`
) SELECT
	`id`, `name`, `role`, `department`, `status`, `pet_id`, '',
	NULL, 'stopped', 'not_provisioned', NULL, `current_task_id`, `created_at`, CURRENT_TIMESTAMP
FROM `employees`;--> statement-breakpoint
DROP TABLE `employees`;--> statement-breakpoint
ALTER TABLE `__new_employees` RENAME TO `employees`;
