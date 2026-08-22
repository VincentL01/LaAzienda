ALTER TABLE `training_center_skills` ADD `folder_key` text COLLATE NOCASE;--> statement-breakpoint
ALTER TABLE `training_center_skills` ADD `observed_digest` text;--> statement-breakpoint
ALTER TABLE `training_center_skills` ADD `observed_at` text;--> statement-breakpoint
ALTER TABLE `training_center_skills` ADD `approved_digest` text;--> statement-breakpoint
ALTER TABLE `training_center_skills` ADD `approval_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `training_center_skills` ADD `approved_at` text;--> statement-breakpoint
WITH `derived_catalog` AS (
  SELECT `id`, CASE WHEN length(`candidate`) BETWEEN 1 AND 80
      AND substr(`candidate`, 1, 1) GLOB '[A-Za-z0-9]'
      AND substr(`candidate`, -1, 1) GLOB '[A-Za-z0-9]'
      AND `candidate` NOT GLOB '*[^A-Za-z0-9_.-]*'
      AND lower(CASE WHEN instr(`candidate`, '.') > 0 THEN substr(`candidate`, 1, instr(`candidate`, '.') - 1) ELSE `candidate` END)
        NOT IN ('con','prn','aux','nul','com1','com2','com3','com4','com5','com6','com7','com8','com9',
          'lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9')
    THEN lower(`candidate`) ELSE NULL END AS `safe_candidate`
  FROM (SELECT `id`, CASE WHEN instr(`package_ref`, '@') > 0
    THEN substr(`package_ref`, instr(`package_ref`, '@') + 1)
    ELSE substr(`package_ref`, instr(`package_ref`, '/') + 1) END AS `candidate`
    FROM `training_center_skills`)
), `ranked_catalog` AS (
  SELECT `id`, `safe_candidate`, row_number() OVER (PARTITION BY `safe_candidate` ORDER BY `id`) AS `folder_rank`
  FROM `derived_catalog`
)
UPDATE `training_center_skills` SET
  `folder_key` = (SELECT CASE WHEN `safe_candidate` IS NOT NULL AND `folder_rank` = 1
    THEN `safe_candidate` ELSE NULL END FROM `ranked_catalog` WHERE `ranked_catalog`.`id` = `training_center_skills`.`id`),
  `cache_status` = CASE WHEN (SELECT `safe_candidate` IS NULL OR `folder_rank` > 1 FROM `ranked_catalog`
    WHERE `ranked_catalog`.`id` = `training_center_skills`.`id`) THEN 'failed' ELSE `cache_status` END,
  `observed_digest` = CASE WHEN (SELECT `safe_candidate` IS NULL OR `folder_rank` > 1 FROM `ranked_catalog`
    WHERE `ranked_catalog`.`id` = `training_center_skills`.`id`) THEN NULL ELSE `observed_digest` END,
  `approved_digest` = CASE WHEN (SELECT `safe_candidate` IS NULL OR `folder_rank` > 1 FROM `ranked_catalog`
    WHERE `ranked_catalog`.`id` = `training_center_skills`.`id`) THEN NULL ELSE `approved_digest` END,
  `updated_at` = CURRENT_TIMESTAMP;--> statement-breakpoint
CREATE TABLE `employee_skills_hardened` (
	`employee_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`folder_key` text COLLATE NOCASE NOT NULL,
	`desired_state` text DEFAULT 'assigned' NOT NULL,
	`assignment_version` integer DEFAULT 1 NOT NULL,
	`assigned_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`employee_id`, `skill_id`),
	UNIQUE(`employee_id`, `folder_key` COLLATE NOCASE)
);--> statement-breakpoint
WITH RECURSIVE `derived` AS (
  SELECT es.`employee_id`, es.`skill_id`, es.`desired_state`, es.`assignment_version`,
    es.`assigned_at`, COALESCE(es.`updated_at`, es.`assigned_at`, CURRENT_TIMESTAMP) AS `updated_at`,
    CASE WHEN instr(s.`package_ref`, '@') > 0
      THEN substr(s.`package_ref`, instr(s.`package_ref`, '@') + 1)
      ELSE substr(s.`package_ref`, instr(s.`package_ref`, '/') + 1)
    END AS `candidate_folder`
  FROM `employee_skills` es LEFT JOIN `training_center_skills` s ON s.`id` = es.`skill_id`
),
`validated` AS (
  SELECT *, CASE WHEN length(`candidate_folder`) BETWEEN 1 AND 80
      AND substr(`candidate_folder`, 1, 1) GLOB '[A-Za-z0-9]'
      AND substr(`candidate_folder`, -1, 1) GLOB '[A-Za-z0-9]'
      AND `candidate_folder` NOT GLOB '*[^A-Za-z0-9_.-]*'
      AND lower(CASE WHEN instr(`candidate_folder`, '.') > 0
        THEN substr(`candidate_folder`, 1, instr(`candidate_folder`, '.') - 1)
        ELSE `candidate_folder` END)
        NOT IN ('con','prn','aux','nul','com1','com2','com3','com4','com5','com6','com7','com8','com9',
          'lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9')
    THEN lower(`candidate_folder`) ELSE NULL END AS `safe_candidate`
  FROM `derived`
),
`ranked` AS (
  SELECT *,
    row_number() OVER (PARTITION BY `employee_id`, `safe_candidate` ORDER BY `skill_id`) AS `duplicate_rank`,
    row_number() OVER (PARTITION BY `employee_id` ORDER BY `skill_id`) AS `employee_ordinal`
  FROM `validated`
),
`reservations` (
  `employee_id`, `skill_id`, `desired_state`, `assignment_version`, `assigned_at`, `updated_at`,
  `safe_candidate`, `duplicate_rank`, `employee_ordinal`, `attempt`, `folder_key`
) AS (
  SELECT `employee_id`, `skill_id`, `desired_state`, `assignment_version`, `assigned_at`, `updated_at`,
    `safe_candidate`, `duplicate_rank`, `employee_ordinal`, 1,
    'legacy-reservation-' || `employee_ordinal` || '-1'
  FROM `ranked`
  WHERE `safe_candidate` IS NULL OR `duplicate_rank` > 1
  UNION ALL
  SELECT r.`employee_id`, r.`skill_id`, r.`desired_state`, r.`assignment_version`, r.`assigned_at`, r.`updated_at`,
    r.`safe_candidate`, r.`duplicate_rank`, r.`employee_ordinal`, r.`attempt` + 1,
    'legacy-reservation-' || r.`employee_ordinal` || '-' || (r.`attempt` + 1)
  FROM `reservations` r
  WHERE EXISTS (
    SELECT 1 FROM `ranked` canonical
    WHERE canonical.`employee_id` = r.`employee_id`
      AND canonical.`safe_candidate` = r.`folder_key`
      AND canonical.`duplicate_rank` = 1
  )
),
`chosen` AS (
  SELECT `employee_id`, `skill_id`, `safe_candidate` AS `folder_key`, `desired_state`, `assignment_version`,
    `assigned_at`, `updated_at`
  FROM `ranked`
  WHERE `safe_candidate` IS NOT NULL AND `duplicate_rank` = 1
  UNION ALL
  SELECT r.`employee_id`, r.`skill_id`, r.`folder_key`, r.`desired_state`, r.`assignment_version`,
    r.`assigned_at`, r.`updated_at`
  FROM `reservations` r
  WHERE NOT EXISTS (
    SELECT 1 FROM `ranked` canonical
    WHERE canonical.`employee_id` = r.`employee_id`
      AND canonical.`safe_candidate` = r.`folder_key`
      AND canonical.`duplicate_rank` = 1
  )
)
INSERT INTO `employee_skills_hardened` (
  `employee_id`, `skill_id`, `folder_key`, `desired_state`, `assignment_version`, `assigned_at`, `updated_at`
)
SELECT `employee_id`, `skill_id`, `folder_key`, `desired_state`, `assignment_version`, `assigned_at`, `updated_at`
FROM `chosen`;--> statement-breakpoint
DROP TABLE `employee_skills`;--> statement-breakpoint
ALTER TABLE `employee_skills_hardened` RENAME TO `employee_skills`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_employee_skills_employee_folder` ON `employee_skills` (`employee_id`,`folder_key` COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `idx_employee_skills_skill` ON `employee_skills` (`skill_id`);--> statement-breakpoint
ALTER TABLE `training_sync_history` ADD `staged_hash` text;--> statement-breakpoint
CREATE TABLE `training_sync_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`history_id` integer NOT NULL,
	`previous_observation_id` integer DEFAULT 0 NOT NULL,
	`employee_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`operation` text NOT NULL,
	`assignment_version` integer NOT NULL,
	`status` text NOT NULL,
	`manifest_version` text,
	`source_hash` text,
	`staged_hash` text,
	`verified_hash` text,
	`evidence` text DEFAULT '' NOT NULL,
	`worker_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`observed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_training_observation_predecessor` ON `training_sync_observations` (`employee_id`,`skill_id`,`operation`,`assignment_version`,`previous_observation_id`);--> statement-breakpoint
CREATE INDEX `idx_training_observation_assignment` ON `training_sync_observations` (`employee_id`,`skill_id`,`operation`,`assignment_version`,`id`);--> statement-breakpoint
CREATE INDEX `idx_training_observation_history` ON `training_sync_observations` (`history_id`,`id`);
