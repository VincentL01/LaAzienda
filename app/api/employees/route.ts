import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";
import {
  desiredRuntimeStatuses,
  mapDockerStatus,
  runtimeStatuses,
  type DesiredRuntimeStatus,
  type EmployeeStatus,
  type RuntimeStatus,
} from "@/lib/company";
import { readWorkforce } from "@/lib/server/workforce";
import { bridgeAuthorized } from "@/lib/server/bridge-auth";

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "employee";
}

const medievalNames = ["Aldric", "Beren", "Cedric", "Darian", "Edric", "Gareth", "Hadrian", "Leofric", "Osric", "Rowan", "Tristan", "Ulric"];

function randomItem<T>(items: T[]) {
  if (!items.length) return undefined;
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return items[value[0] % items.length];
}

export async function GET() {
  try {
    await ensureDatabase();
    return Response.json(await readWorkforce());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Workforce unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const d1 = env.DB;

    if (body.action === "onboard") {
      let name = cleanText(body.name, 60);
      const requestedRole = cleanText(body.role, 80);
      const requestedDepartment = cleanText(body.department, 80);
      const requestedPrompt = cleanText(body.systemPrompt, 8000);
      const requestedProfileId = cleanText(body.roleProfileId, 80);
      const requestedPetId = cleanText(body.petId, 80);
      const skillIds = Array.isArray(body.skillIds)
        ? [...new Set(body.skillIds.filter((id): id is string => typeof id === "string"))].slice(0, 20)
        : [];

      const roleProfile = requestedProfileId
        ? await d1.prepare(`SELECT id, title, department, system_prompt AS systemPrompt,
            recommended_skills AS recommendedSkills, employment_type AS employmentType,
            workspace_policy AS workspacePolicy, resource_access AS resourceAccess,
            docker_socket_access AS dockerSocketAccess, handoff_required AS handoffRequired,
            pet_policy AS petPolicy, fixed_pet_id AS fixedPetId, is_singleton AS isSingleton
            FROM company_roles WHERE id = ?`).bind(requestedProfileId).first<{
              id: string; title: string; department: string; systemPrompt: string; recommendedSkills: string;
              employmentType: "executive" | "expert" | "contractor"; workspacePolicy: "persistent" | "task-scoped";
              resourceAccess: "read-all" | "docker-provisioner" | "project-write" | "task-scoped";
              dockerSocketAccess: number; handoffRequired: number; petPolicy: "fixed" | "random";
              fixedPetId: string | null; isSingleton: number;
            }>()
        : await d1.prepare(`SELECT id, title, department, system_prompt AS systemPrompt,
            recommended_skills AS recommendedSkills, employment_type AS employmentType,
            workspace_policy AS workspacePolicy, resource_access AS resourceAccess,
            docker_socket_access AS dockerSocketAccess, handoff_required AS handoffRequired,
            pet_policy AS petPolicy, fixed_pet_id AS fixedPetId, is_singleton AS isSingleton
            FROM company_roles WHERE title = ?`).bind(requestedRole).first<{
              id: string; title: string; department: string; systemPrompt: string; recommendedSkills: string;
              employmentType: "executive" | "expert" | "contractor"; workspacePolicy: "persistent" | "task-scoped";
              resourceAccess: "read-all" | "docker-provisioner" | "project-write" | "task-scoped";
              dockerSocketAccess: number; handoffRequired: number; petPolicy: "fixed" | "random";
              fixedPetId: string | null; isSingleton: number;
            }>();
      if (!roleProfile) return Response.json({ error: "Choose a company role profile" }, { status: 400 });
      if (roleProfile.isSingleton) {
        const staffed = await d1.prepare("SELECT id FROM employees WHERE role_profile_id = ?").bind(roleProfile.id).first();
        if (staffed) return Response.json({ error: `${roleProfile.title} is already staffed` }, { status: 409 });
      }
      if (roleProfile.employmentType === "contractor") {
        const baseName = randomItem(medievalNames) ?? "Aldric";
        const collision = await d1.prepare("SELECT id FROM employees WHERE name = ?").bind(baseName).first();
        name = collision ? `${baseName} ${crypto.randomUUID().slice(0, 4).toUpperCase()}` : baseName;
      }
      if (name.length < 2) return Response.json({ error: "Name is required for permanent employees" }, { status: 400 });
      const role = requestedRole || roleProfile.title;
      const department = requestedDepartment || roleProfile.department;
      const systemPrompt = requestedPrompt || roleProfile.systemPrompt;
      if (systemPrompt.length < 30) return Response.json({ error: "The employee brain needs a system prompt of at least 30 characters" }, { status: 400 });
      let petId = requestedPetId;
      if (roleProfile.petPolicy === "fixed") petId = roleProfile.fixedPetId ?? "";
      if (roleProfile.petPolicy === "random") {
        const petPool = await d1.prepare(`SELECT id FROM character_packs
          WHERE cache_status = 'cached' AND id NOT IN ('aurelia-executive-04', 'crimson-executive', 'solaire')
          ORDER BY id`).all<{ id: string }>();
        petId = randomItem(petPool.results)?.id ?? requestedPetId;
      }
      const character = await d1.prepare("SELECT id FROM character_packs WHERE id = ? AND cache_status = 'cached'").bind(petId).first();
      if (!character) return Response.json({ error: "The role's character policy has no cached character available" }, { status: 400 });

      const cachedSkills = await d1.prepare(`SELECT id, package_ref AS packageRef
        FROM training_center_skills WHERE cache_status = 'cached'`).all<{ id: string; packageRef: string }>();
      const recommended = new Set<string>(JSON.parse(roleProfile.recommendedSkills));
      const recommendedSkillIds = cachedSkills.results
        .filter((skill) => recommended.has(skill.packageRef.split("@").at(-1) ?? ""))
        .map((skill) => skill.id);
      const effectiveSkillIds = [...new Set([...skillIds, ...recommendedSkillIds])].slice(0, 30);
      for (const skillId of effectiveSkillIds) {
        const skill = await d1.prepare("SELECT id FROM training_center_skills WHERE id = ? AND cache_status = 'cached'").bind(skillId).first();
        if (!skill) return Response.json({ error: "Every assigned skill must be cached in the Training Center" }, { status: 400 });
      }

      const id = `employee-${crypto.randomUUID()}`;
      const containerName = `omc-${slugify(name)}-${id.slice(-6)}`;
      const emailStem = slugify(name).replace(/-/g, ".");
      const existingEmail = await d1.prepare("SELECT id FROM employees WHERE email_address = ?")
        .bind(`${emailStem}@one-man-company.test`).first();
      const emailAddress = `${emailStem}${existingEmail ? `.${id.slice(-6)}` : ""}@one-man-company.test`;
      const statements = [
        d1.prepare(`INSERT INTO employees (
          id, name, role, department, status, pet_id, role_profile_id, employment_type,
          workspace_policy, resource_access, docker_socket_access, handoff_required, email_address, mailbox_status,
          system_prompt, container_name, desired_runtime_status, runtime_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, 'stopped', 'not_provisioned', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
          .bind(id, name, role, department, petId, roleProfile.id, roleProfile.employmentType,
            roleProfile.workspacePolicy, roleProfile.resourceAccess, roleProfile.dockerSocketAccess,
            roleProfile.handoffRequired, emailAddress, systemPrompt, containerName),
        d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'success')")
          .bind(`${name} joined ${department} as ${role}.`),
        d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'neutral')")
          .bind(`${emailAddress} was requested from the local mail service.`),
        ...effectiveSkillIds.map((skillId) => d1.prepare("INSERT INTO employee_skills (employee_id, skill_id) VALUES (?, ?)").bind(id, skillId)),
      ];
      await d1.batch(statements);
    } else if (body.action === "requestRuntime") {
      const employeeId = cleanText(body.employeeId, 80);
      const desired = String(body.desired) as DesiredRuntimeStatus;
      if (!desiredRuntimeStatuses.includes(desired)) return Response.json({ error: "Unknown desired runtime state" }, { status: 400 });
      const employee = await d1.prepare(`SELECT name, desired_runtime_status AS desiredRuntimeStatus
        FROM employees WHERE id = ?`).bind(employeeId).first<{ name: string; desiredRuntimeStatus: DesiredRuntimeStatus }>();
      if (!employee) return Response.json({ error: "Employee not found" }, { status: 404 });
      if (employee.desiredRuntimeStatus !== desired) {
        await d1.batch([
          d1.prepare(`UPDATE employees SET desired_runtime_status = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(desired, employeeId),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, ?)")
            .bind(`${employee.name}'s container was requested to ${desired === "running" ? "start" : "stop"}.`, desired === "running" ? "working" : "neutral"),
        ]);
      }
    } else if (body.action === "reportRuntime") {
      if (!bridgeAuthorized(request)) return Response.json({ error: "Runtime bridge authorization failed" }, { status: 403 });
      const employeeId = cleanText(body.employeeId, 80);
      const eventKey = cleanText(body.eventKey, 160);
      const detail = cleanText(body.detail, 500);
      const runtimeStatus = String(body.runtimeStatus) as RuntimeStatus;
      if (!eventKey || !runtimeStatuses.includes(runtimeStatus)) return Response.json({ error: "A valid runtime event is required" }, { status: 400 });

      const duplicate = await d1.prepare("SELECT id FROM runtime_events WHERE event_key = ?").bind(eventKey).first();
      if (!duplicate) {
        const employee = await d1.prepare("SELECT name, status FROM employees WHERE id = ?")
          .bind(employeeId).first<{ name: string; status: EmployeeStatus }>();
        if (!employee) return Response.json({ error: "Employee not found" }, { status: 404 });
        const employeeStatus = mapDockerStatus(runtimeStatus, employee.status);
        await d1.batch([
          d1.prepare(`UPDATE employees SET runtime_status = ?, status = ?, last_runtime_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(runtimeStatus, employeeStatus, employeeId),
          d1.prepare(`INSERT INTO runtime_events (event_key, employee_id, container_status, employee_status, detail)
            VALUES (?, ?, ?, ?, ?)`).bind(eventKey, employeeId, runtimeStatus, employeeStatus, detail),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, ?)")
            .bind(`${employee.name}'s container reported ${runtimeStatus}.`, runtimeStatus === "dead" ? "failed" : runtimeStatus === "running" ? "success" : "neutral"),
        ]);
      }
    } else {
      return Response.json({ error: "Unknown employee action" }, { status: 400 });
    }

    return Response.json(await readWorkforce());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Employee action failed" }, { status: 500 });
  }
}
