CREATE TABLE `contractor_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`handoff_key` text NOT NULL,
	`task_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`summary` text NOT NULL,
	`deliverables` text NOT NULL,
	`decisions` text DEFAULT '' NOT NULL,
	`follow_up` text DEFAULT '' NOT NULL,
	`knowledge_entry_id` text NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_handoffs_key` ON `contractor_handoffs` (`handoff_key`);--> statement-breakpoint
CREATE INDEX `idx_handoffs_task_status` ON `contractor_handoffs` (`task_id`,`status`);--> statement-breakpoint
CREATE TABLE `knowledge_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`source_type` text DEFAULT 'handoff' NOT NULL,
	`source_ref` text,
	`contributed_by` text,
	`task_id` text,
	`status` text DEFAULT 'candidate' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_status_created` ON `knowledge_entries` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`github_owner` text DEFAULT 'VincentL01' NOT NULL,
	`repository_name` text,
	`repository_url` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`manager_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_repository_url` ON `projects` (`repository_url`);--> statement-breakpoint
CREATE TABLE `runtime_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`image_tag` text NOT NULL,
	`harness` text NOT NULL,
	`base_tools` text DEFAULT '[]' NOT NULL,
	`codex_home` text NOT NULL,
	`workspace_path` text NOT NULL,
	`skills_path` text NOT NULL,
	`auth_contract` text NOT NULL,
	`docker_socket_policy` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `company_roles` ADD `employment_type` text DEFAULT 'expert' NOT NULL;--> statement-breakpoint
ALTER TABLE `company_roles` ADD `workspace_policy` text DEFAULT 'persistent' NOT NULL;--> statement-breakpoint
ALTER TABLE `company_roles` ADD `resource_access` text DEFAULT 'task-scoped' NOT NULL;--> statement-breakpoint
ALTER TABLE `company_roles` ADD `docker_socket_access` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `company_roles` ADD `handoff_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `company_roles` ADD `pet_policy` text DEFAULT 'random' NOT NULL;--> statement-breakpoint
ALTER TABLE `company_roles` ADD `fixed_pet_id` text;--> statement-breakpoint
ALTER TABLE `company_roles` ADD `is_singleton` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `employees` ADD `employment_type` text DEFAULT 'expert' NOT NULL;--> statement-breakpoint
ALTER TABLE `employees` ADD `workspace_policy` text DEFAULT 'persistent' NOT NULL;--> statement-breakpoint
ALTER TABLE `employees` ADD `resource_access` text DEFAULT 'task-scoped' NOT NULL;--> statement-breakpoint
ALTER TABLE `employees` ADD `docker_socket_access` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `employees` ADD `handoff_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `handoff_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_tasks_project_status` ON `tasks` (`project_id`,`status`);