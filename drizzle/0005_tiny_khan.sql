ALTER TABLE `agent_runs` ADD `execution_cycle` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `execution_cycle` integer DEFAULT 1 NOT NULL;