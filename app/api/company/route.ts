import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";
import {
  animationStates,
  employeeStatuses,
  taskStatuses,
  type AnimationMapping,
  type CompanyState,
  type EmployeeStatus,
  type TaskStatus,
  type TrainingSkill,
} from "@/lib/company";
import { bridgeAuthorized } from "@/lib/server/bridge-auth";

async function readCompany(): Promise<CompanyState> {
  const d1 = env.DB;
  const [employees, tasks, mappings, activity, assignedSkills, projects, knowledge, handoffs] = await Promise.all([
    d1.prepare(`SELECT employees.id, employees.name, role, department, status, pet_id AS petId,
      character_packs.spritesheet_path AS spritesheetPath,
      role_profile_id AS roleProfileId, employment_type AS employmentType,
      workspace_policy AS workspacePolicy, resource_access AS resourceAccess,
      docker_socket_access AS dockerSocketAccess, handoff_required AS handoffRequired,
      email_address AS emailAddress, mailbox_status AS mailboxStatus,
      system_prompt AS systemPrompt, container_name AS containerName,
      desired_runtime_status AS desiredRuntimeStatus, runtime_status AS runtimeStatus,
      last_runtime_at AS lastRuntimeAt, current_task_id AS currentTaskId,
      employees.created_at AS createdAt FROM employees
      LEFT JOIN character_packs ON character_packs.id = employees.pet_id
      ORDER BY CASE employees.id WHEN 'employee-hrm' THEN 0 WHEN 'employee-dorothy' THEN 1 ELSE 2 END, employees.created_at`).all(),
    d1.prepare(`SELECT id, title, brief, status, priority, assignee_id AS assigneeId,
      project_id AS projectId, handoff_required AS handoffRequired,
      created_at AS createdAt, updated_at AS updatedAt
      FROM tasks ORDER BY CASE status WHEN 'working' THEN 0 WHEN 'review' THEN 1
      WHEN 'queued' THEN 2 ELSE 3 END, updated_at DESC`).all(),
    d1.prepare(`SELECT employee_status AS employeeStatus, animation_state AS animationState,
      speed_ms AS speedMs FROM animation_mappings ORDER BY rowid`).all(),
    d1.prepare(`SELECT id, message, tone, created_at AS createdAt
      FROM activity ORDER BY id DESC LIMIT 12`).all(),
    d1.prepare(`SELECT es.employee_id AS employeeId, s.id, s.package_ref AS packageRef,
      s.name, s.description, s.source_url AS sourceUrl, s.install_command AS installCommand,
      s.cache_status AS cacheStatus, s.created_at AS createdAt, s.cached_at AS cachedAt
      FROM employee_skills es JOIN training_center_skills s ON s.id = es.skill_id
      ORDER BY s.name`).all(),
    d1.prepare(`SELECT id, name, brief, github_owner AS githubOwner,
      repository_name AS repositoryName, repository_url AS repositoryUrl,
      visibility, status, manager_id AS managerId, created_at AS createdAt, updated_at AS updatedAt
      FROM projects ORDER BY updated_at DESC`).all(),
    d1.prepare(`SELECT id, title, summary, source_type AS sourceType, source_ref AS sourceRef,
      contributed_by AS contributedBy, task_id AS taskId, status, created_at AS createdAt
      FROM knowledge_entries ORDER BY created_at DESC LIMIT 60`).all(),
    d1.prepare(`SELECT id, handoff_key AS handoffKey, task_id AS taskId, employee_id AS employeeId,
      summary, deliverables, decisions, follow_up AS followUp, knowledge_entry_id AS knowledgeEntryId,
      status, created_at AS createdAt FROM contractor_handoffs ORDER BY created_at DESC LIMIT 60`).all(),
  ]);

  const employeeRows = employees.results.map((row) => {
    const employee = row as unknown as Omit<CompanyState["employees"][number], "dockerSocketAccess" | "handoffRequired" | "skills"> & {
      dockerSocketAccess: number; handoffRequired: number;
    };
    return { ...employee, dockerSocketAccess: Boolean(employee.dockerSocketAccess), handoffRequired: Boolean(employee.handoffRequired), skills: [] };
  });
  const taskRows = tasks.results.map((row) => {
    const task = row as unknown as Omit<CompanyState["tasks"][number], "handoffRequired"> & { handoffRequired: number };
    return { ...task, handoffRequired: Boolean(task.handoffRequired) };
  });
  const skillRows = assignedSkills.results as unknown as Array<TrainingSkill & { employeeId: string }>;
  for (const employee of employeeRows) {
    employee.skills = skillRows.filter((skill) => skill.employeeId === employee.id);
  }

  return {
    employees: employeeRows,
    tasks: taskRows,
    mappings: mappings.results as unknown as CompanyState["mappings"],
    activity: activity.results as unknown as CompanyState["activity"],
    projects: projects.results as unknown as CompanyState["projects"],
    knowledge: knowledge.results as unknown as CompanyState["knowledge"],
    handoffs: handoffs.results as unknown as CompanyState["handoffs"],
  };
}

export async function GET() {
  try {
    await ensureDatabase();
    return Response.json(await readCompany());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Company state is unavailable" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const action = body.action;
    const d1 = env.DB;

    if (action === "createTask") {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const brief = typeof body.brief === "string" ? body.brief.trim().slice(0, 4000) : "";
      const priority = ["low", "normal", "high"].includes(String(body.priority)) ? String(body.priority) : "normal";
      const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : null;
      const assigneeId = typeof body.assigneeId === "string" && body.assigneeId ? body.assigneeId : null;
      if (!title) return Response.json({ error: "A task title is required" }, { status: 400 });
      if (projectId && !await d1.prepare("SELECT id FROM projects WHERE id = ?").bind(projectId).first()) {
        return Response.json({ error: "Project not found" }, { status: 404 });
      }
      const assignee = assigneeId
        ? await d1.prepare("SELECT name, handoff_required AS handoffRequired, resource_access AS resourceAccess FROM employees WHERE id = ?")
          .bind(assigneeId).first<{ name: string; handoffRequired: number; resourceAccess: string }>()
        : null;
      if (assigneeId && !assignee) return Response.json({ error: "Assignee not found" }, { status: 404 });
      if (assignee?.resourceAccess === "read-all") return Response.json({ error: "The Secretary is read-only and cannot own tasks" }, { status: 400 });

      const taskId = `task-${crypto.randomUUID()}`;
      await d1.batch([
        d1.prepare(`INSERT INTO tasks (
          id, title, brief, status, priority, assignee_id, project_id, handoff_required
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`)
          .bind(taskId, title, brief, priority, assigneeId, projectId, assignee?.handoffRequired ?? 0),
        d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'neutral')").bind(`CEO added "${title}" to the company queue.`),
      ]);
    } else if (action === "createProject") {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
      const brief = typeof body.brief === "string" ? body.brief.trim().slice(0, 4000) : "";
      const managerId = typeof body.managerId === "string" && body.managerId ? body.managerId : null;
      if (name.length < 2 || brief.length < 20) return Response.json({ error: "Project name and a useful brief are required" }, { status: 400 });
      if (managerId) {
        const manager = await d1.prepare("SELECT role_profile_id AS roleProfileId FROM employees WHERE id = ?").bind(managerId)
          .first<{ roleProfileId: string | null }>();
        if (!manager || manager.roleProfileId !== "project-manager") {
          return Response.json({ error: "Choose an onboarded Project Manager" }, { status: 400 });
        }
      }
      const id = `project-${crypto.randomUUID()}`;
      await d1.batch([
        d1.prepare(`INSERT INTO projects (
          id, name, brief, github_owner, visibility, status, manager_id
        ) VALUES (?, ?, ?, 'VincentL01', 'public', 'planned', ?)`)
          .bind(id, name, brief, managerId),
        d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'neutral')")
          .bind(`CEO opened the ${name} project record. Its public GitHub repository is not provisioned yet.`),
      ]);
    } else if (action === "approveProject") {
      const projectId = typeof body.projectId === "string" ? body.projectId : "";
      const project = await d1.prepare("SELECT name, status FROM projects WHERE id = ?").bind(projectId)
        .first<{ name: string; status: string }>();
      if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
      if (project.status === "planned") {
        await d1.batch([
          d1.prepare("UPDATE projects SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(projectId),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'success')")
            .bind(`CEO approved ${project.name} for a public VincentL01 repository.`),
        ]);
      }
    } else if (action === "reportProjectRepository") {
      if (!bridgeAuthorized(request)) return Response.json({ error: "Runtime bridge authorization failed" }, { status: 403 });
      const projectId = typeof body.projectId === "string" ? body.projectId : "";
      const managerId = typeof body.managerId === "string" ? body.managerId : "";
      const repositoryName = typeof body.repositoryName === "string" ? body.repositoryName.trim() : "";
      const repositoryUrl = typeof body.repositoryUrl === "string" ? body.repositoryUrl.trim() : "";
      if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(repositoryName) || repositoryUrl !== `https://github.com/VincentL01/${repositoryName}`) {
        return Response.json({ error: "Repository must be the approved public VincentL01 GitHub repository" }, { status: 400 });
      }
      const project = await d1.prepare(`SELECT name, status, manager_id AS managerId,
        repository_url AS repositoryUrl FROM projects WHERE id = ?`).bind(projectId)
        .first<{ name: string; status: string; managerId: string | null; repositoryUrl: string | null }>();
      const manager = await d1.prepare("SELECT role_profile_id AS roleProfileId FROM employees WHERE id = ?")
        .bind(managerId).first<{ roleProfileId: string | null }>();
      if (!project || project.status !== "approved" || project.managerId !== managerId || manager?.roleProfileId !== "project-manager") {
        return Response.json({ error: "Only the assigned Project Manager may report an approved repository" }, { status: 403 });
      }
      if (project.repositoryUrl && project.repositoryUrl !== repositoryUrl) {
        return Response.json({ error: "This project already points to another repository" }, { status: 409 });
      }
      if (!project.repositoryUrl) {
        await d1.batch([
          d1.prepare(`UPDATE projects SET repository_name = ?, repository_url = ?, status = 'provisioned',
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(repositoryName, repositoryUrl, projectId),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'success')")
            .bind(`${project.name} was linked to ${repositoryUrl} by its Project Manager.`),
        ]);
      }
    } else if (action === "submitHandoff") {
      const taskId = typeof body.taskId === "string" ? body.taskId : "";
      const employeeId = typeof body.employeeId === "string" ? body.employeeId : "";
      const handoffKey = typeof body.handoffKey === "string" ? body.handoffKey.trim().slice(0, 160) : "";
      const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 4000) : "";
      const deliverables = typeof body.deliverables === "string" ? body.deliverables.trim().slice(0, 6000) : "";
      const decisions = typeof body.decisions === "string" ? body.decisions.trim().slice(0, 4000) : "";
      const followUp = typeof body.followUp === "string" ? body.followUp.trim().slice(0, 4000) : "";
      const knowledge = typeof body.knowledge === "string" ? body.knowledge.trim().slice(0, 5000) : "";
      if (!handoffKey || summary.length < 20 || deliverables.length < 10 || knowledge.length < 20) {
        return Response.json({ error: "A handoff needs a summary, deliverables, reusable knowledge, and retry key" }, { status: 400 });
      }
      const task = await d1.prepare(`SELECT title, assignee_id AS assigneeId, handoff_required AS handoffRequired
        FROM tasks WHERE id = ?`).bind(taskId).first<{ title: string; assigneeId: string | null; handoffRequired: number }>();
      const employee = await d1.prepare("SELECT name, employment_type AS employmentType FROM employees WHERE id = ?")
        .bind(employeeId).first<{ name: string; employmentType: string }>();
      if (!task || !employee || task.assigneeId !== employeeId || employee.employmentType !== "contractor" || !task.handoffRequired) {
        return Response.json({ error: "This task is not awaiting that contractor's handoff" }, { status: 400 });
      }
      const handoffId = `handoff-${crypto.randomUUID()}`;
      const knowledgeId = `knowledge-${crypto.randomUUID()}`;
      const result = await d1.prepare(`INSERT OR IGNORE INTO contractor_handoffs (
        id, handoff_key, task_id, employee_id, summary, deliverables, decisions,
        follow_up, knowledge_entry_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`)
        .bind(handoffId, handoffKey, taskId, employeeId, summary, deliverables, decisions, followUp, knowledgeId).run();
      if ((result.meta.changes ?? 0) > 0) {
        await d1.batch([
          d1.prepare(`INSERT INTO knowledge_entries (
            id, title, summary, source_type, source_ref, contributed_by, task_id, status
          ) VALUES (?, ?, ?, 'handoff', ?, ?, ?, 'approved')`)
            .bind(knowledgeId, `${task.title} handoff`, knowledge, handoffId, employeeId, taskId),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'success')")
            .bind(`${employee.name} submitted an accepted handoff and returned knowledge to the company.`),
        ]);
      }
    } else if (action === "advanceTask") {
      const taskId = typeof body.taskId === "string" ? body.taskId : "";
      const task = await d1.prepare("SELECT title, status, assignee_id AS assigneeId FROM tasks WHERE id = ?")
        .bind(taskId).first<{ title: string; status: TaskStatus; assigneeId: string | null }>();
      if (!task || !taskStatuses.includes(task.status)) return Response.json({ error: "Task not found" }, { status: 404 });

      const nextStatus: Record<TaskStatus, TaskStatus> = { queued: "working", working: "review", review: "done", done: "done" };
      const next = nextStatus[task.status];
      const assigneeId = task.assigneeId;
      if (!assigneeId) return Response.json({ error: "Assign an employee before starting the task" }, { status: 400 });
      const assignedPolicy = await d1.prepare(`SELECT resource_access AS resourceAccess, handoff_required AS handoffRequired
        FROM employees WHERE id = ?`).bind(assigneeId).first<{ resourceAccess: string; handoffRequired: number }>();
      if (!assignedPolicy || assignedPolicy.resourceAccess === "read-all") {
        return Response.json({ error: "This employee cannot execute tasks" }, { status: 400 });
      }
      if (next === "done") {
        if (assignedPolicy.handoffRequired) {
          const accepted = await d1.prepare(`SELECT id FROM contractor_handoffs
            WHERE task_id = ? AND employee_id = ? AND status = 'accepted'`).bind(taskId, assigneeId).first();
          if (!accepted) return Response.json({ error: "Contractor handoff is required before this task can ship" }, { status: 409 });
        }
      }
      const assignee = await d1.prepare("SELECT name FROM employees WHERE id = ?").bind(assigneeId).first<{ name: string }>();
      const employeeStatus: Record<TaskStatus, EmployeeStatus> = { queued: "planning", working: "working", review: "review", done: "done" };
      const label: Record<TaskStatus, string> = { queued: "queued", working: "started", review: "moved into review", done: "shipped" };
      const statements = [
        d1.prepare("UPDATE tasks SET status = ?, assignee_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(next, assigneeId, taskId),
        d1.prepare("INSERT INTO activity (message, tone) VALUES (?, ?)").bind(`${assignee?.name ?? "An employee"} ${label[next]} "${task.title}".`, next === "done" ? "success" : next),
      ];
      statements.push(
        next === "done"
          ? d1.prepare("UPDATE employees SET status = ?, current_task_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(employeeStatus[next], assigneeId)
          : d1.prepare("UPDATE employees SET status = ?, current_task_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(employeeStatus[next], taskId, assigneeId),
      );
      await d1.batch(statements);
    } else if (action === "setEmployeeStatus") {
      const employeeId = typeof body.employeeId === "string" ? body.employeeId : "";
      const status = String(body.status) as EmployeeStatus;
      if (!employeeStatuses.includes(status)) return Response.json({ error: "Unknown employee status" }, { status: 400 });
      const employee = await d1.prepare("SELECT name FROM employees WHERE id = ?").bind(employeeId).first<{ name: string }>();
      if (!employee) return Response.json({ error: "Employee not found" }, { status: 404 });
      await d1.batch([
        d1.prepare("UPDATE employees SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, employeeId),
        d1.prepare("INSERT INTO activity (message, tone) VALUES (?, ?)").bind(`${employee.name} is now ${status}.`, status),
      ]);
    } else if (action === "saveMappings") {
      const mappings = Array.isArray(body.mappings) ? body.mappings as AnimationMapping[] : [];
      if (mappings.length !== employeeStatuses.length) return Response.json({ error: "Every employee status needs an animation" }, { status: 400 });

      const statements = mappings.map((mapping) => {
        if (!employeeStatuses.includes(mapping.employeeStatus) || !animationStates.includes(mapping.animationState)) throw new Error("Invalid animation mapping");
        const speed = Math.max(80, Math.min(600, Number(mapping.speedMs) || 180));
        return d1.prepare(`INSERT INTO animation_mappings (employee_status, animation_state, speed_ms)
          VALUES (?, ?, ?) ON CONFLICT(employee_status) DO UPDATE SET
          animation_state = excluded.animation_state, speed_ms = excluded.speed_ms`)
          .bind(mapping.employeeStatus, mapping.animationState, speed);
      });
      statements.push(d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'success')").bind("Animation rules were updated."));
      await d1.batch(statements);
    } else {
      return Response.json({ error: "Unknown company action" }, { status: 400 });
    }

    return Response.json(await readCompany());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The action could not be completed" },
      { status: 500 },
    );
  }
}
