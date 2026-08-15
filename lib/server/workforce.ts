import { env } from "cloudflare:workers";
import type { CharacterPack, CompanyRole, RuntimeEvent, RuntimeProfile, TrainingSkill, WorkforceState } from "@/lib/company";

export async function readWorkforce(): Promise<WorkforceState> {
  const d1 = env.DB;
  const [employees, assignedSkills, skills, characters, runtimeEvents, roles, runtimeProfile] = await Promise.all([
    d1.prepare(`SELECT id, name, role, department, status, pet_id AS petId,
      role_profile_id AS roleProfileId, email_address AS emailAddress, mailbox_status AS mailboxStatus,
      employment_type AS employmentType, workspace_policy AS workspacePolicy,
      resource_access AS resourceAccess, docker_socket_access AS dockerSocketAccess,
      handoff_required AS handoffRequired,
      system_prompt AS systemPrompt, container_name AS containerName,
      desired_runtime_status AS desiredRuntimeStatus, runtime_status AS runtimeStatus,
      last_runtime_at AS lastRuntimeAt, current_task_id AS currentTaskId,
      created_at AS createdAt FROM employees ORDER BY CASE id WHEN 'employee-hrm' THEN 0 WHEN 'employee-dorothy' THEN 1 ELSE 2 END, created_at`).all(),
    d1.prepare(`SELECT es.employee_id AS employeeId, s.id, s.package_ref AS packageRef,
      s.name, s.description, s.source_url AS sourceUrl, s.install_command AS installCommand,
      s.cache_status AS cacheStatus, s.created_at AS createdAt, s.cached_at AS cachedAt
      FROM employee_skills es JOIN training_center_skills s ON s.id = es.skill_id
      ORDER BY s.name`).all(),
    d1.prepare(`SELECT id, package_ref AS packageRef, name, description,
      source_url AS sourceUrl, install_command AS installCommand,
      cache_status AS cacheStatus, created_at AS createdAt, cached_at AS cachedAt
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
    const employee = row as unknown as Omit<WorkforceState["employees"][number], "dockerSocketAccess" | "handoffRequired" | "skills"> & {
      dockerSocketAccess: number; handoffRequired: number;
    };
    return {
      ...employee,
      dockerSocketAccess: Boolean(employee.dockerSocketAccess),
      handoffRequired: Boolean(employee.handoffRequired),
      skills: [],
    };
  });
  const assignedRows = assignedSkills.results as unknown as Array<TrainingSkill & { employeeId: string }>;
  for (const employee of employeeRows) {
    employee.skills = assignedRows.filter((skill) => skill.employeeId === employee.id);
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
