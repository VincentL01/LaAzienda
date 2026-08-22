import {
  fingerprintIncident,
  normalizeIncidentRoute,
  sanitizeIncidentText,
  type SystemIncidentCategory,
} from "../system-incident-policy.ts";

export interface PortalIncidentObservation {
  category: SystemIncidentCategory;
  route: string;
  method: string;
  httpStatus?: number | null;
  summary: unknown;
  evidence?: unknown;
  runId?: string | null;
  buildCommit?: string | null;
}

type ActiveRun = {
  id: string;
  taskId: string | null;
  employeeId: string;
  employeeName: string;
};

type ExistingIncident = {
  status: string;
  buildCommit: string | null;
};

export function shouldRequeueIncidentForBuild(
  status: string,
  previousBuildCommit: string | null,
  observedBuildCommit: string | null,
) {
  return (status === "filed" || status === "blocked")
    && Boolean(observedBuildCommit)
    && observedBuildCommit !== previousBuildCommit;
}

export function incidentRunEventMessage(status: string, issueNumber: number | null) {
  if (status === "filed" && issueNumber) {
    return `The Company Portal repeated a known internal incident; GitHub issue #${issueNumber} is already filed.`;
  }
  if (status === "blocked") {
    return "The Company Portal repeated an internal incident whose automatic GitHub filing is blocked.";
  }
  return "The Company Portal detected an internal incident; GitHub issue filing is pending.";
}

async function findActiveRun(d1: D1Database, requestedRunId?: string | null) {
  if (requestedRunId && /^[A-Za-z0-9._-]{8,120}$/.test(requestedRunId)) {
    return await d1.prepare(`SELECT runs.id, runs.task_id AS taskId,
      runs.employee_id AS employeeId, employees.name AS employeeName
      FROM agent_runs runs JOIN employees ON employees.id = runs.employee_id
      WHERE runs.id = ? AND runs.status IN ('claimed', 'running')`)
      .bind(requestedRunId).first<ActiveRun>();
  }

  const active = await d1.prepare(`SELECT runs.id, runs.task_id AS taskId,
    runs.employee_id AS employeeId, employees.name AS employeeName
    FROM agent_runs runs JOIN employees ON employees.id = runs.employee_id
    WHERE runs.status IN ('claimed', 'running')
    ORDER BY COALESCE(runs.heartbeat_at, runs.started_at, runs.created_at) DESC LIMIT 2`)
    .all<ActiveRun>();
  return active.results.length === 1 ? active.results[0] : null;
}

export async function recordSystemIncident(d1: D1Database, observation: PortalIncidentObservation) {
  const activeRun = await findActiveRun(d1, observation.runId);
  if (!activeRun) return null;

  const route = normalizeIncidentRoute(observation.route);
  const method = sanitizeIncidentText(observation.method, 12).toUpperCase() || "UNKNOWN";
  const summary = sanitizeIncidentText(observation.summary, 600) || "The Company Portal returned an internal error.";
  const evidence = sanitizeIncidentText(observation.evidence, 2400);
  const buildCommit = /^[a-f0-9]{7,64}$/i.test(observation.buildCommit ?? "")
    ? observation.buildCommit!.toLowerCase()
    : null;
  const httpStatus = Number.isInteger(observation.httpStatus)
    && Number(observation.httpStatus) >= 500 && Number(observation.httpStatus) <= 599
    ? Number(observation.httpStatus)
    : null;
  const fingerprint = await fingerprintIncident({ category: observation.category, method, route, summary });
  const incidentId = `incident-${fingerprint.slice(0, 40)}`;

  const existing = await d1.prepare(`SELECT status, build_commit AS buildCommit
    FROM system_incidents WHERE fingerprint = ?`).bind(fingerprint).first<ExistingIncident>();

  const inserted = await d1.prepare(`INSERT OR IGNORE INTO system_incidents (
    id, fingerprint, category, source, route, method, http_status, summary, evidence,
    run_id, employee_id, task_id, build_commit
  ) VALUES (?, ?, ?, 'worker', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(incidentId, fingerprint, observation.category, route, method, httpStatus, summary, evidence,
      activeRun.id, activeRun.employeeId, activeRun.taskId, buildCommit).run();

  const requeued = Boolean(existing && shouldRequeueIncidentForBuild(existing.status, existing.buildCommit, buildCommit));
  if ((inserted.meta.changes ?? 0) === 0 && requeued) {
    await d1.prepare(`UPDATE system_incidents SET occurrence_count = occurrence_count + 1,
      last_seen_at = CURRENT_TIMESTAMP, summary = ?, evidence = ?, http_status = ?,
      run_id = ?, employee_id = ?, task_id = ?, build_commit = ?, status = 'pending',
      next_attempt_at = NULL, lease_owner = NULL, lease_token = NULL,
      lease_expires_at = NULL, last_filing_error = NULL WHERE fingerprint = ?`)
      .bind(summary, evidence, httpStatus, activeRun.id, activeRun.employeeId, activeRun.taskId, buildCommit, fingerprint)
      .run();
  } else if ((inserted.meta.changes ?? 0) === 0) {
    await d1.prepare(`UPDATE system_incidents SET occurrence_count = occurrence_count + 1,
      last_seen_at = CURRENT_TIMESTAMP, summary = ?, evidence = ?, http_status = ?,
      run_id = ?, employee_id = ?, task_id = ?, build_commit = COALESCE(?, build_commit)
      WHERE fingerprint = ?`)
      .bind(summary, evidence, httpStatus, activeRun.id, activeRun.employeeId, activeRun.taskId, buildCommit, fingerprint)
      .run();
  }

  const persisted = await d1.prepare(`SELECT id, fingerprint, status, issue_number AS issueNumber,
    issue_url AS issueUrl, occurrence_count AS occurrenceCount FROM system_incidents WHERE fingerprint = ?`)
    .bind(fingerprint).first<{ id: string; fingerprint: string; status: string; issueNumber: number | null;
      issueUrl: string | null; occurrenceCount: number }>();
  if (!persisted) throw new Error("The recorded system incident could not be read back.");

  const eventMessage = incidentRunEventMessage(persisted.status, persisted.issueNumber);
  const statements = [
    d1.prepare(`INSERT OR IGNORE INTO agent_run_events (
      event_key, run_id, employee_id, event_type, message
    ) VALUES (?, ?, ?, 'system_bug', ?)`)
      .bind(`system-incident:${fingerprint}:${activeRun.id}:${persisted.status}`, activeRun.id, activeRun.employeeId, eventMessage),
    d1.prepare("UPDATE agent_runs SET last_event = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('claimed', 'running')")
      .bind(eventMessage, activeRun.id),
  ];
  if ((inserted.meta.changes ?? 0) > 0 || requeued) {
    statements.push(d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'failed')")
      .bind(`Company Portal detected an internal incident during ${activeRun.employeeName}'s active run; GitHub issue filing is pending.`));
  }
  await d1.batch(statements);

  return persisted;
}
