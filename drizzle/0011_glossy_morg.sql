CREATE TABLE `control_generations` (
	`control_key` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `control_generations` (`control_key`, `generation`, `updated_at`)
VALUES ('training', 1, CURRENT_TIMESTAMP);
