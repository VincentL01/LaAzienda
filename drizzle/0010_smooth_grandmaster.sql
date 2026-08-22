DROP INDEX `idx_employee_skills_employee_folder`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_employee_skills_employee_folder` ON `employee_skills` (`employee_id`,"folder_key" COLLATE NOCASE);--> statement-breakpoint
ALTER TABLE `training_center_skills` ADD `observation_status` text;--> statement-breakpoint
ALTER TABLE `training_center_skills` ADD `observation_evidence` text;--> statement-breakpoint
UPDATE `training_center_skills`
SET `observation_status` = 'failed',
    `observation_evidence` = 'This package has no unique portable cache folder reservation; submit a package with a unique skill suffix.',
    `updated_at` = CURRENT_TIMESTAMP
WHERE `folder_key` IS NULL AND `cache_status` = 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX `idx_training_skills_folder` ON `training_center_skills` ("folder_key" COLLATE NOCASE) WHERE "training_center_skills"."folder_key" IS NOT NULL;
