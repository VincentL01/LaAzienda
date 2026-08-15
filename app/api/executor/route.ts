import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";
import { bridgeAuthorized } from "@/lib/server/bridge-auth";

const MAX_ATTEMPTS = 3;
const ACTIVE_RUNS = "('claimed', 'running')";
const failureMessages = {
  authentication_required: "Codex authentication needs to be refreshed by the CEO.",
  repository_unavailable: "The approved repository could not be prepared for this run.",
  result_invalid: "Codex finished without a valid structured handoff.",
  execution_failed: "Codex execution failed.",
} as const;

type ClaimedJob = {
  runId: string;
  jobType: "task" | "secretary-inquiry";
  jobId: string;
  employeeId: string;
  employeeName: string;
  containerName: string;
  sandbox: "read-only" | "workspace-write";
  repositoryUrl: string | null;
  prompt: string;
};

const eventMessages: Record<string, string> = {
  "thread.started": "Codex opened an execution thread.",
  "turn.started": "Codex started working through the brief.",
  command: "The employee is running a workspace command.",
  file_change: "The employee updated project files.",
  web_search: "The employee is checking an external source.",
  agent_message: "The employee produced a progress update.",
  "turn.completed": "Codex completed the execution turn.",
  error: "Codex reported an execution error.",
};

function cleanText(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit)
    .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{10,}\b/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
}

function cleanList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((item) => cleanText(item, 1200)).filter(Boolean);
}

async function recoverExpiredRuns() {
  const d1 = env.DB;
  const expired = await d1.prepare(`SELECT id, job_type AS jobType, job_id AS jobId,
    task_id AS taskId, employee_id AS employeeId, attempt
    FROM agent_runs WHERE status IN ${ACTIVE_RUNS}
    AND lease_expires_at IS NOT NULL AND lease_expires_at < CURRENT_TIMESTAMP`).all<{
      id: string; jobType: string; jobId: string; taskId: string | null; employeeId: string; attempt: number;
    }>();

  for (const run of expired.results) {
    const exhausted = run.attempt >= MAX_ATTEMPTS;
    const statements = [
      d1.prepare(`UPDATE agent_runs SET status = 'failed', error = 'Worker heartbeat expired.',
        last_event = 'The worker heartbeat expired.', finished_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ${ACTIVE_RUNS}`).bind(run.id),
      d1.prepare(`UPDATE employees SET status = ?, current_task_id = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(exhausted ? "failed" : "waiting", run.employeeId),
      d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'failed')")
        .bind(exhausted ? "An agent run exhausted its retry limit." : "An agent run lost its heartbeat and returned to the queue."),
    ];
    if (run.jobType === "task" && run.taskId) {
      statements.push(d1.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(exhausted ? "review" : "queued", run.taskId));
    } else if (run.jobType === "secretary-inquiry") {
      statements.push(d1.prepare("UPDATE secretary_inquiries SET status = ?, run_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(exhausted ? "failed" : "queued", run.jobId));
    }
    await d1.batch(statements);
  }
}

async function claimSecretaryInquiry(workerId: string): Promise<ClaimedJob | null> {
  const d1 = env.DB;
  const inquiry = await d1.prepare(`SELECT inquiries.id, inquiries.question,
    employees.id AS employeeId, employees.name AS employeeName, employees.container_name AS containerName
    FROM secretary_inquiries inquiries
    JOIN employees ON employees.id = 'employee-dorothy'
    WHERE inquiries.status = 'queued' AND employees.desired_runtime_status = 'running'
      AND employees.runtime_status = 'running'
      AND (SELECT COUNT(*) FROM agent_runs runs
        WHERE runs.job_type = 'secretary-inquiry' AND runs.job_id = inquiries.id) < ?
    ORDER BY inquiries.created_at LIMIT 1`).bind(MAX_ATTEMPTS).first<{
      id: string; question: string; employeeId: string; employeeName: string; containerName: string | null;
    }>();
  if (!inquiry?.containerName) return null;

  const attemptRow = await d1.prepare(`SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
    FROM agent_runs WHERE job_type = 'secretary-inquiry' AND job_id = ?`).bind(inquiry.id).first<{ attempt: number }>();
  const attempt = attemptRow?.attempt ?? 1;
  const runId = `run-${crypto.randomUUID()}`;
  const inserted = await d1.prepare(`INSERT OR IGNORE INTO agent_runs (
    id, job_type, job_id, employee_id, status, attempt, worker_id, prompt_summary,
    lease_expires_at, heartbeat_at, started_at
  ) VALUES (?, 'secretary-inquiry', ?, ?, 'claimed', ?, ?, ?, datetime('now', '+2 minutes'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .bind(runId, inquiry.id, inquiry.employeeId, attempt, workerId, inquiry.question.slice(0, 240)).run();
  if ((inserted.meta.changes ?? 0) === 0) return null;

  await d1.batch([
    d1.prepare("UPDATE secretary_inquiries SET status = 'running', run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(runId, inquiry.id),
    d1.prepare("UPDATE employees SET status = 'working', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(inquiry.employeeId),
    d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'working')")
      .bind(`Dorothy is preparing a live company briefing: "${inquiry.question.slice(0, 100)}".`),
  ]);

  return {
    runId,
    jobType: "secretary-inquiry",
    jobId: inquiry.id,
    employeeId: inquiry.employeeId,
    employeeName: inquiry.employeeName,
    containerName: inquiry.containerName,
    sandbox: "read-only",
    repositoryUrl: null,
    prompt: `Answer the CEO's question using only fresh company evidence. Run company-status before answering.\n\nQuestion: ${inquiry.question}\n\nState what is happening now, cite the responsible employee and task or run, call out stale or missing evidence, and give the next concrete checkpoint. Do not mutate any company resource and never include credentials or secret values.`,
  };
}

async function claimTask(workerId: string): Promise<ClaimedJob | null> {
  const d1 = env.DB;
  const task = await d1.prepare(`SELECT tasks.id, tasks.title, tasks.brief, tasks.handoff_required AS handoffRequired,
    tasks.execution_cycle AS executionCycle,
    employees.id AS employeeId, employees.name AS employeeName, employees.container_name AS containerName,
    employees.employment_type AS employmentType, employees.role, projects.name AS projectName,
    projects.brief AS projectBrief, projects.repository_url AS repositoryUrl
    FROM tasks JOIN employees ON employees.id = tasks.assignee_id
    LEFT JOIN projects ON projects.id = tasks.project_id
    WHERE tasks.status = 'queued' AND employees.resource_access NOT IN ('read-all', 'docker-provisioner')
      AND employees.desired_runtime_status = 'running' AND employees.runtime_status = 'running'
      AND (SELECT COUNT(*) FROM agent_runs runs WHERE runs.job_type = 'task' AND runs.job_id = tasks.id
        AND runs.execution_cycle = tasks.execution_cycle) < ?
    ORDER BY CASE tasks.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
      tasks.created_at LIMIT 1`).bind(MAX_ATTEMPTS).first<{
        id: string; title: string; brief: string; handoffRequired: number; executionCycle: number; employeeId: string;
        employeeName: string; containerName: string | null; employmentType: string; role: string;
        projectName: string | null; projectBrief: string | null; repositoryUrl: string | null;
      }>();
  if (!task?.containerName) return null;

  const attemptRow = await d1.prepare(`SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
    FROM agent_runs WHERE job_type = 'task' AND job_id = ? AND execution_cycle = ?`)
    .bind(task.id, task.executionCycle).first<{ attempt: number }>();
  const attempt = attemptRow?.attempt ?? 1;
  const runId = `run-${crypto.randomUUID()}`;
  const inserted = await d1.prepare(`INSERT OR IGNORE INTO agent_runs (
    id, job_type, job_id, task_id, employee_id, status, attempt, execution_cycle, worker_id, prompt_summary,
    lease_expires_at, heartbeat_at, started_at
  ) VALUES (?, 'task', ?, ?, ?, 'claimed', ?, ?, ?, ?, datetime('now', '+2 minutes'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .bind(runId, task.id, task.id, task.employeeId, attempt, task.executionCycle, workerId, task.title.slice(0, 240)).run();
  if ((inserted.meta.changes ?? 0) === 0) return null;

  await d1.batch([
    d1.prepare("UPDATE tasks SET status = 'working', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'")
      .bind(task.id),
    d1.prepare(`UPDATE employees SET status = 'planning', current_task_id = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(task.id, task.employeeId),
    d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'working')")
      .bind(`${task.employeeName} claimed "${task.title}" for execution.`),
  ]);

  const projectContext = task.projectName
    ? `Project: ${task.projectName}\nProject brief: ${task.projectBrief ?? "No project brief recorded."}\nRepository: ${task.repositoryUrl ?? "No repository is linked."}`
    : "No project is linked to this task. Work only inside the isolated task workspace.";
  const handoff = task.handoffRequired
    ? "This is contractor work. Your final structured result must include concrete deliverables, decisions, follow-up, and reusable knowledge for the mandatory handoff."
    : "Return concrete evidence, decisions, follow-up work, and reusable knowledge in the final structured result.";

  return {
    runId,
    jobType: "task",
    jobId: task.id,
    employeeId: task.employeeId,
    employeeName: task.employeeName,
    containerName: task.containerName,
    sandbox: "workspace-write",
    repositoryUrl: task.repositoryUrl,
    prompt: `Execute this approved company task as ${task.employeeName}, ${task.role}.\n\nTask: ${task.title}\nBrief: ${task.brief || "No additional brief was supplied."}\n${projectContext}\n\n${handoff}\n\nRepository rule: make changes only on a codex/* branch and use a pull request; never commit or push directly to main. Work autonomously within the stated scope, validate in proportion to risk, and never print or return credentials. If authority or required context is missing, return needs_input with the exact blocker instead of inventing completion.`,
  };
}

async function claim(workerId: string) {
  await recoverExpiredRuns();
  return await claimSecretaryInquiry(workerId) ?? await claimTask(workerId);
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    if (!bridgeAuthorized(request)) return Response.json({ error: "Runtime bridge authorization failed" }, { status: 403 });
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    const workerId = cleanText(body.workerId, 120);
    if (!workerId) return Response.json({ error: "A worker identity is required" }, { status: 400 });
    const d1 = env.DB;

    if (action === "claim") {
      return Response.json({ job: await claim(workerId) });
    }

    const runId = cleanText(body.runId, 120);
    if (!runId) return Response.json({ error: "A run id is required" }, { status: 400 });
    const run = await d1.prepare(`SELECT id, job_type AS jobType, job_id AS jobId, task_id AS taskId,
      employee_id AS employeeId, status, attempt, worker_id AS workerId
      FROM agent_runs WHERE id = ?`).bind(runId).first<{
        id: string; jobType: string; jobId: string; taskId: string | null; employeeId: string;
        status: string; attempt: number; workerId: string;
      }>();
    if (!run || run.workerId !== workerId) return Response.json({ error: "Run not found for this worker" }, { status: 404 });
    if (!["claimed", "running"].includes(run.status)) return Response.json({ ok: true, terminal: true });

    if (action === "heartbeat") {
      await d1.prepare(`UPDATE agent_runs SET status = 'running', heartbeat_at = CURRENT_TIMESTAMP,
        lease_expires_at = datetime('now', '+2 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(runId).run();
      return Response.json({ ok: true });
    }

    if (action === "event") {
      const eventKey = cleanText(body.eventKey, 180);
      const eventType = cleanText(body.eventType, 80);
      const message = eventMessages[eventType];
      if (!eventKey || !message) return Response.json({ error: "Unsupported executor event" }, { status: 400 });
      const threadId = /^[A-Za-z0-9-]{8,100}$/.test(String(body.threadId ?? "")) ? String(body.threadId) : null;
      await d1.batch([
        d1.prepare(`INSERT OR IGNORE INTO agent_run_events (
          event_key, run_id, employee_id, event_type, message
        ) VALUES (?, ?, ?, ?, ?)`).bind(eventKey, runId, run.employeeId, eventType, message),
        d1.prepare(`UPDATE agent_runs SET status = 'running', last_event = ?,
          thread_id = COALESCE(?, thread_id), heartbeat_at = CURRENT_TIMESTAMP,
          lease_expires_at = datetime('now', '+2 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(message, threadId, runId),
        d1.prepare("UPDATE employees SET status = 'working', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(run.employeeId),
      ]);
      return Response.json({ ok: true });
    }

    if (action === "complete") {
      const result = body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : {};
      const resultStatus = result.status === "needs_input" ? "needs_input" : "completed";
      const summary = cleanText(result.summary, 6000) || "The employee completed the run without a written summary.";
      const currentState = cleanText(result.current_state, 2400);
      const deliverables = cleanList(result.deliverables);
      const decisions = cleanList(result.decisions);
      const followUp = cleanList(result.follow_up);
      const knowledge = cleanText(result.knowledge, 6000);
      const employeeStatus = run.jobType === "secretary-inquiry"
        ? "idle"
        : resultStatus === "needs_input" ? "waiting" : "review";
      const statements = [
        d1.prepare(`UPDATE agent_runs SET status = ?, result_summary = ?, deliverables = ?, decisions = ?,
          follow_up = ?, knowledge = ?, last_event = ?, heartbeat_at = CURRENT_TIMESTAMP,
          lease_expires_at = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(resultStatus, summary, JSON.stringify(deliverables), JSON.stringify(decisions), JSON.stringify(followUp), knowledge,
            currentState || (resultStatus === "needs_input" ? "Waiting for CEO input." : "Ready for review."), runId),
        d1.prepare("UPDATE employees SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(employeeStatus, run.employeeId),
      ];

      if (run.jobType === "secretary-inquiry") {
        statements.push(d1.prepare(`UPDATE secretary_inquiries SET status = 'answered', answer = ?,
          answered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(summary, run.jobId));
        statements.push(d1.prepare("INSERT INTO activity (message, tone) VALUES ('Dorothy delivered a live company briefing.', 'success')"));
      } else if (run.taskId) {
        statements.push(d1.prepare("UPDATE tasks SET status = 'review', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(run.taskId));
        statements.push(d1.prepare("INSERT INTO activity (message, tone) VALUES (?, ?)")
          .bind(resultStatus === "needs_input" ? "An employee moved a task to review with a blocker." : "An employee completed a task run and requested review.", employeeStatus));
      }
      await d1.batch(statements);

      if (run.jobType === "task" && run.taskId && resultStatus === "completed") {
        const task = await d1.prepare(`SELECT tasks.title, tasks.handoff_required AS handoffRequired,
          employees.employment_type AS employmentType FROM tasks
          JOIN employees ON employees.id = tasks.assignee_id WHERE tasks.id = ?`).bind(run.taskId)
          .first<{ title: string; handoffRequired: number; employmentType: string }>();
        if (task?.employmentType === "contractor" && task.handoffRequired && knowledge.length >= 20) {
          const handoffId = `handoff-${crypto.randomUUID()}`;
          const knowledgeId = `knowledge-${crypto.randomUUID()}`;
          await d1.batch([
            d1.prepare(`INSERT OR IGNORE INTO contractor_handoffs (
              id, handoff_key, task_id, employee_id, summary, deliverables, decisions,
              follow_up, knowledge_entry_id, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted')`)
              .bind(handoffId, `executor:${runId}`, run.taskId, run.employeeId, summary,
                deliverables.join("\n"), decisions.join("\n"), followUp.join("\n"), knowledgeId),
            d1.prepare(`INSERT OR IGNORE INTO knowledge_entries (
              id, title, summary, source_type, source_ref, contributed_by, task_id, status
            ) VALUES (?, ?, ?, 'handoff', ?, ?, ?, 'approved')`)
              .bind(knowledgeId, `${task.title} handoff`, knowledge, handoffId, run.employeeId, run.taskId),
          ]);
        }
      }
      return Response.json({ ok: true });
    }

    if (action === "fail") {
      const requestedFailure = cleanText(body.failureCode, 80) as keyof typeof failureMessages;
      const failureCode = requestedFailure in failureMessages ? requestedFailure : "execution_failed";
      const failureMessage = failureMessages[failureCode];
      const needsOwner = failureCode === "authentication_required";
      const exhausted = needsOwner || run.attempt >= MAX_ATTEMPTS;
      const statements = [
        d1.prepare(`UPDATE agent_runs SET status = 'failed', error = ?,
          last_event = ?, lease_expires_at = NULL,
          finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(failureMessage, failureMessage, runId),
        d1.prepare("UPDATE employees SET status = ?, current_task_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(exhausted ? "failed" : "waiting", run.employeeId),
        d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'failed')")
          .bind(needsOwner ? "Agent execution paused because Codex authentication requires CEO attention."
            : exhausted ? "An employee run needs human review after three attempts."
              : "An employee run failed and will be retried."),
      ];
      if (run.jobType === "task" && run.taskId) {
        statements.push(d1.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(exhausted ? "review" : "queued", run.taskId));
      } else if (run.jobType === "secretary-inquiry") {
        statements.push(d1.prepare("UPDATE secretary_inquiries SET status = ?, run_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(exhausted ? "failed" : "queued", run.jobId));
      }
      await d1.batch(statements);
      return Response.json({ ok: true, retry: !exhausted });
    }

    return Response.json({ error: "Unknown executor action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Executor action failed" }, { status: 500 });
  }
}
