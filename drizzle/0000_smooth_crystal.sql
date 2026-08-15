CREATE TABLE `activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message` text NOT NULL,
	`tone` text DEFAULT 'neutral' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_created` ON `activity` (`created_at`);--> statement-breakpoint
CREATE TABLE `animation_mappings` (
	`employee_status` text PRIMARY KEY NOT NULL,
	`animation_state` text NOT NULL,
	`speed_ms` integer DEFAULT 180 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`department` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`pet_id` text NOT NULL,
	`current_task_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignee_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status_updated` ON `tasks` (`status`,`updated_at`);