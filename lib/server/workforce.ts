import { env } from "cloudflare:workers";
import type { CharacterPack, CompanyRole, DesiredEmployeeSkill, RuntimeEvent, RuntimeProfile, TrainingSkill, WorkforceState } from "@/lib/company";

export async function readWorkforce(): Promise<WorkforceState> {
  const d1 = env.DB;
  const [employees, verifiedSkills, desiredSkills, skills, characters, runtimeEvents, roles, runtimeProfile] = await Promise.all([
    d1.prepare(`SELECT id, name, role, department, status, pet_id AS petId,
      role_profile_id AS roleProfileId, email_address AS emailAddress, mailbox_status AS mailboxStatus,
      employment_type AS employmentType, workspace_policy AS workspacePolicy,
      resource_access AS resourceAccess, docker_socket_access AS dockerSocketAccess,
      handoff_required AS handoffRequired,
      system_prompt AS systemPrompt, container_name AS containerName,
      desired_runtime_status AS desiredRuntimeStatus, runtime_status AS runtimeStatus,
      last_runtime_at AS lastRuntimeAt, current_task_id AS currentTaskId,
      created_at AS createdAt FROM employees ORDER BY CASE id WHEN 'employee-hrm' THEN 0 WHEN 'employee-dorothy' THEN 1 ELSE 2 END, created_at`).all(),
    d1.prepare(`WITH latest AS (
        SELECT es.employee_id, es.skill_id, es.desired_state, es.assignment_version,
          (SELECT MAX(o.id) FROM training_sync_observations o
            WHERE o.employee_id = es.employee_id AND o.skill_id = es.skill_id
              AND o.operation = CASE es.desired_state WHEN 'revoked' THEN 'remove' ELSE 'install' END
              AND o.assignment_version = es.assignment_version) AS observation_id
        FROM employee_skills es
      ), converged AS (
        SELECT latest.employee_id, MIN(o.manifest_version) AS manifest_version
        FROM latest JOIN training_sync_observations o ON o.id = latest.observation_id
        GROUP BY latest.employee_id
        HAVING COUNT(*) = (SELECT COUNT(*) FROM latest expected WHERE expected.employee_id = latest.employee_id)
          AND MIN(CASE WHEN o.status = 'verified' THEN 1 ELSE 0 END) = 1
          AND COUNT(DISTINCT o.manifest_version) = 1
      )
      SELECT es.employee_id AS employeeId, s.id, s.package_ref AS packageRef,
        s.name, s.description, s.source_url AS sourceUrl, s.install_command AS installCommand,
        s.folder_key AS folderKey, s.cache_status AS cacheStatus,
        s.observed_digest AS observedDigest, s.observed_at AS observedAt,
        s.observation_status AS observationStatus, s.observation_evidence AS observationEvidence,
        s.approved_digest AS approvedDigest, s.approval_version AS approvalVersion,
        s.approved_at AS approvedAt, s.created_at AS createdAt, s.cached_at AS cachedAt,
        s.updated_at AS updatedAt
      FROM employee_skills es
      JOIN training_center_skills s ON s.id = es.skill_id
      JOIN latest ON latest.employee_id = es.employee_id AND latest.skill_id = es.skill_id
      JOIN training_sync_observations o ON o.id = latest.observation_id
      JOIN converged ON converged.employee_id = es.employee_id AND converged.manifest_version = o.manifest_version
      WHERE es.desired_state = 'assigned' AND o.operation = 'install' AND o.status = 'verified'
        AND o.source_hash = s.approved_digest AND o.staged_hash = s.approved_digest
        AND o.verified_hash = s.approved_digest AND s.observed_digest = s.approved_digest
      ORDER BY s.name`).all(),
    d1.prepare(`SELECT es.employee_id AS employeeId, es.assignment_version AS assignmentVersion,
      es.assigned_at AS assignedAt, es.updated_at AS desiredUpdatedAt, es.folder_key AS folderKey,
      s.id, s.package_ref AS packageRef, s.name, s.description, s.source_url AS sourceUrl,
      s.install_command AS installCommand, s.cache_status AS cacheStatus,
      s.observed_digest AS observedDigest, s.observed_at AS observedAt,
      s.observation_status AS observationStatus, s.observation_evidence AS observationEvidence,
      s.approved_digest AS approvedDigest, s.approval_version AS approvalVersion,
      s.approved_at AS approvedAt, s.created_at AS createdAt, s.cached_at AS cachedAt,
      s.updated_at AS updatedAt
      FROM employee_skills es JOIN training_center_skills s ON s.id = es.skill_id
      WHERE es.desired_state = 'assigned' ORDER BY s.name`).all(),
    d1.prepare(`SELECT id, package_ref AS packageRef, name, description,
      source_url AS sourceUrl, install_command AS installCommand,
      folder_key AS folderKey, cache_status AS cacheStatus,
      observed_digest AS observedDigest, observed_at AS observedAt,
      observation_status AS observationStatus, observation_evidence AS observationEvidence,
      approved_digest AS approvedDigest, approval_version AS approvalVersion,
      approved_at AS approvedAt, created_at AS createdAt, cached_at AS cachedAt,
      updated_at AS updatedAt
      FROM training_center_skills ORDER BY CASE cache_status WHEN 'cached' THEN 0 ELSE 1 END, name`).all(),
    d1.prepare(`SELECT id, display_name AS displayName, description, source_url AS sourceUrl,
      install_command AS installCommand, spritesheet_path AS spritesheetPath,
      sprite_version AS spriteVersion, cache_status AS cacheStatus,
      created_at AS createdAt, cached_at AS cachedAt
      FROM character_packs ORDER BY CASE cache_status WHEN 'cached' THEN 0 ELSE 1 END, display_name`).all(),
    d1.prepare(`SELECT id, event_key AS eventKey, employee_id AS employeeId,
      container_status AS containerStatus, employee_status AS employeeStatus,
      detail, created_at AS createdAt FROM runtime_events ORDER BY id DESC LIMIT 30`).all(),
    d1.prepare(`SELECT id, title, department, mission, system_prompt AS systemPrompt,
      recommended_skills AS recommendedSkills, employment_type AS employmentType,
      workspace_policy AS workspacePolicy, resource_access AS resourceAccess,
      docker_socket_access AS dockerSocketAccess, handoff_required AS handoffRequired,
      pet_policy AS petPolicy, fixed_pet_id AS fixedPetId, is_singleton AS isSingleton,
      harness, model_policy AS modelPolicy,
      is_core AS isCore, sort_order AS sortOrder FROM company_roles ORDER BY sort_order, title`).all(),
    d1.prepare(`SELECT id, image_tag AS imageTag, harness, base_tools AS baseTools,
      codex_home AS codexHome, workspace_path AS workspacePath, skills_path AS skillsPath,
      auth_contract AS authContract, docker_socket_policy AS dockerSocketPolicy, description
      FROM runtime_profiles WHERE id = 'codex-base'`).first(),
  ]);

  const employeeRows = employees.results.map((row) => {
    const employee = row as unknown as Omit<WorkforceState["employees"][number], "dockerSocketAccess" | "handoffRequired" | "skills" | "desiredSkills"> & {
      dockerSocketAccess: number; handoffRequired: number;
    };
    return {
      ...employee,
      dockerSocketAccess: Boolean(employee.dockerSocketAccess),
      handoffRequired: Boolean(employee.handoffRequired),
      skills: [],
      desiredSkills: [],
    };
  });
  const verifiedRows = verifiedSkills.results as unknown as Array<TrainingSkill & { employeeId: string }>;
  const desiredRows = desiredSkills.results as unknown as Array<DesiredEmployeeSkill & { employeeId: string }>;
  for (const employee of employeeRows) {
    employee.skills = verifiedRows.filter((skill) => skill.employeeId === employee.id);
    employee.desiredSkills = desiredRows.filter((skill) => skill.employeeId === employee.id);
  }

  const roleRows = roles.results.map((row) => {
    const role = row as unknown as Omit<CompanyRole, "recommendedSkills" | "isCore" | "dockerSocketAccess" | "handoffRequired" | "isSingleton"> & {
      recommendedSkills: string; isCore: number; dockerSocketAccess: number; handoffRequired: number; isSingleton: number;
    };
    return {
      ...role,
      recommendedSkills: JSON.parse(role.recommendedSkills) as string[],
      isCore: Boolean(role.isCore),
      dockerSocketAccess: Boolean(role.dockerSocketAccess),
      handoffRequired: Boolean(role.handoffRequired),
      isSingleton: Boolean(role.isSingleton),
    };
  });

  if (!runtimeProfile) throw new Error("The Codex base image profile is missing");
  const profile = runtimeProfile as unknown as Omit<RuntimeProfile, "baseTools"> & { baseTools: string };

  return {
    employees: employeeRows,
    skills: skills.results as unknown as TrainingSkill[],
    characters: characters.results as unknown as CharacterPack[],
    runtimeEvents: runtimeEvents.results as unknown as RuntimeEvent[],
    roles: roleRows,
    runtimeProfile: { ...profile, baseTools: JSON.parse(profile.baseTools) as string[] },
  };
}
