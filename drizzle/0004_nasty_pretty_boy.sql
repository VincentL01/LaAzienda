CREATE TABLE `agent_run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_key` text NOT NULL,
	`run_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`event_type` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_run_events_key` ON `agent_run_events` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_agent_run_events_run_created` ON `agent_run_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_run_events_employee_created` ON `agent_run_events` (`employee_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`job_id` text NOT NULL,
	`task_id` text,
	`employee_id` text NOT NULL,
	`status` text DEFAULT 'claimed' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`worker_id` text NOT NULL,
	`prompt_summary` text DEFAULT '' NOT NULL,
	`last_event` text DEFAULT 'Claimed by the company dispatcher.' NOT NULL,
	`result_summary` text DEFAULT '' NOT NULL,
	`deliverables` text DEFAULT '[]' NOT NULL,
	`decisions` text DEFAULT '[]' NOT NULL,
	`follow_up` text DEFAULT '[]' NOT NULL,
	`knowledge` text DEFAULT '' NOT NULL,
	`error` text,
	`thread_id` text,
	`lease_expires_at` text,
	`heartbeat_at` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runs_employee_created` ON `agent_runs` (`employee_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_task_created` ON `agent_runs` (`task_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_runs_active_job` ON `agent_runs` (`job_type`,`job_id`) WHERE status IN ('claimed', 'running');--> statement-breakpoint
CREATE TABLE `secretary_inquiries` (
	`id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`run_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`answered_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_secretary_inquiries_status_created` ON `secretary_inquiries` (`status`,`created_at`);