CREATE TABLE `system_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`category` text NOT NULL,
	`source` text NOT NULL,
	`route` text NOT NULL,
	`method` text NOT NULL,
	`http_status` integer,
	`summary` text NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	`run_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`task_id` text,
	`build_commit` text,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`issue_number` integer,
	`issue_url` text,
	`filing_attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` text,
	`last_filing_error` text,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_system_incidents_fingerprint` ON `system_incidents` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_system_incidents_delivery` ON `system_incidents` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_system_incidents_employee_seen` ON `system_incidents` (`employee_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_system_incidents_run_seen` ON `system_incidents` (`run_id`,`last_seen_at`);