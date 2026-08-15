CREATE TABLE `company_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`department` text NOT NULL,
	`mission` text NOT NULL,
	`system_prompt` text NOT NULL,
	`recommended_skills` text DEFAULT '[]' NOT NULL,
	`harness` text DEFAULT 'Codex CLI · codex exec' NOT NULL,
	`model_policy` text DEFAULT 'Company default Codex model' NOT NULL,
	`is_core` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 100 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`message_key` text NOT NULL,
	`sender_employee_id` text NOT NULL,
	`recipient_employee_id` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`transport` text DEFAULT 'stalwart' NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`sent_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mail_messages_key` ON `mail_messages` (`message_key`);--> statement-breakpoint
CREATE INDEX `idx_mail_messages_status_created` ON `mail_messages` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `employees` ADD `role_profile_id` text;--> statement-breakpoint
ALTER TABLE `employees` ADD `email_address` text;--> statement-breakpoint
ALTER TABLE `employees` ADD `mailbox_status` text DEFAULT 'requested' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_employees_email_address` ON `employees` (`email_address`);