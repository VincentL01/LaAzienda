import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";
import { bridgeAuthorized } from "@/lib/server/bridge-auth";

const failureMessages = {
  network: "GitHub could not be reached by the incident watcher.",
  rate_limited: "GitHub rate-limited automated incident filing.",
  verification_failed: "The created GitHub issue could not be independently verified.",
  permission_denied: "The GitHub credential does not have permission to create issues.",
  issues_disabled: "GitHub Issues are disabled for VincentL01/LaAzienda.",
} as const;

type FailureCode = keyof typeof failureMessages;

function cleanIdentifier(value: unknown, limit = 120) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]+$/.test(value)
    ? value.slice(0, limit)
    : "";
}

async function claimIncident(workerId: string) {
  const d1 = env.DB;
  await d1.prepare(`UPDATE system_incidents SET status = 'pending', lease_owner = NULL,
      lease_token = NULL, lease_expires_at = NULL
      WHERE status = 'filing' AND lease_expires_at < CURRENT_TIMESTAMP`).run();

  const candidate = await d1.prepare(`SELECT id FROM system_incidents
    WHERE status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
    ORDER BY first_seen_at, id LIMIT 1`).first<{ id: string }>();
  if (!candidate) return null;

  const leaseToken = crypto.randomUUID();
  const claimed = await d1.prepare(`UPDATE system_incidents SET status = 'filing',
    filing_attempts = filing_attempts + 1, lease_owner = ?, lease_token = ?,
    lease_expires_at = datetime('now', '+2 minutes'), last_filing_error = NULL
    WHERE id = ? AND status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)`)
    .bind(workerId, leaseToken, candidate.id).run();
  if ((claimed.meta.changes ?? 0) === 0) return null;

  return await d1.prepare(`SELECT incidents.id, incidents.fingerprint, incidents.category,
    incidents.source, incidents.route, incidents.method, incidents.http_status AS httpStatus,
    incidents.summary, incidents.evidence, incidents.run_id AS runId,
    incidents.employee_id AS employeeId, employees.name AS employeeName,
    incidents.task_id AS taskId, tasks.title AS taskTitle, incidents.build_commit AS buildCommit,
    incidents.occurrence_count AS occurrenceCount, incidents.filing_attempts AS filingAttempts,
    incidents.first_seen_at AS firstSeenAt, incidents.last_seen_at AS lastSeenAt,
    incidents.lease_token AS leaseToken
    FROM system_incidents incidents
    JOIN employees ON employees.id = incidents.employee_id
    LEFT JOIN tasks ON tasks.id = incidents.task_id
    WHERE incidents.id = ? AND incidents.lease_owner = ? AND incidents.lease_token = ?`)
    .bind(candidate.id, workerId, leaseToken).first();
}

async function completeIncident(workerId: string, body: Record<string, unknown>) {
  const incidentId = cleanIdentifier(body.incidentId);
  const leaseToken = cleanIdentifier(body.leaseToken);
  const issueNumber = Number(body.issueNumber);
  const issueUrl = typeof body.issueUrl === "string" ? body.issueUrl.trim() : "";
  if (!incidentId || !leaseToken || !Number.isSafeInteger(issueNumber) || issueNumber < 1
    || issueUrl !== `https://github.com/VincentL01/LaAzienda/issues/${issueNumber}`) {
    return Response.json({ error: "A verified LaAzienda issue is required" }, { status: 400 });
  }

  const existing = await env.DB.prepare(`SELECT status, issue_number AS issueNumber,
    issue_url AS issueUrl FROM system_incidents WHERE id = ?`).bind(incidentId)
    .first<{ status: string; issueNumber: number | null; issueUrl: string | null }>();
  if (existing?.status === "filed" && existing.issueNumber === issueNumber && existing.issueUrl === issueUrl) {
    return Response.json({ ok: true, terminal: true });
  }

  const updated = await env.DB.prepare(`UPDATE system_incidents SET status = 'filed',
    issue_number = ?, issue_url = ?, next_attempt_at = NULL, lease_owner = NULL,
    lease_token = NULL, lease_expires_at = NULL, last_filing_error = NULL
    WHERE id = ? AND status = 'filing' AND lease_owner = ? AND lease_token = ?`)
    .bind(issueNumber, issueUrl, incidentId, workerId, leaseToken).run();
  if ((updated.meta.changes ?? 0) === 0) {
    return Response.json({ error: "Incident filing lease is no longer active" }, { status: 409 });
  }
  await env.DB.prepare("INSERT INTO activity (message, tone) VALUES (?, 'success')")
    .bind(`System incident ${incidentId} was filed as GitHub issue #${issueNumber}.`).run();
  return Response.json({ ok: true });
}

async function failIncident(workerId: string, body: Record<string, unknown>) {
  const incidentId = cleanIdentifier(body.incidentId);
  const leaseToken = cleanIdentifier(body.leaseToken);
  const requestedCode = cleanIdentifier(body.failureCode, 80) as FailureCode;
  const failureCode: FailureCode = Object.hasOwn(failureMessages, requestedCode) ? requestedCode : "network";
  if (!incidentId || !leaseToken) return Response.json({ error: "Incident lease is required" }, { status: 400 });

  const incident = await env.DB.prepare(`SELECT filing_attempts AS filingAttempts
    FROM system_incidents WHERE id = ? AND status = 'filing' AND lease_owner = ? AND lease_token = ?`)
    .bind(incidentId, workerId, leaseToken).first<{ filingAttempts: number }>();
  if (!incident) return Response.json({ error: "Incident filing lease is no longer active" }, { status: 409 });

  const retryDelay = incident.filingAttempts <= 1 ? "+1 minute"
    : incident.filingAttempts === 2 ? "+5 minutes"
      : incident.filingAttempts === 3 ? "+30 minutes" : "+2 hours";
  const updated = await env.DB.prepare(`UPDATE system_incidents SET status = 'pending', next_attempt_at = ?,
    lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, last_filing_error = ?
    WHERE id = ? AND status = 'filing' AND lease_owner = ? AND lease_token = ?`)
    .bind(new Date(Date.now() + (
      retryDelay === "+1 minute" ? 60_000 : retryDelay === "+5 minutes" ? 300_000
        : retryDelay === "+30 minutes" ? 1_800_000 : 7_200_000
    )).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""), failureMessages[failureCode],
      incidentId, workerId, leaseToken).run();
  if ((updated.meta.changes ?? 0) === 0) {
    return Response.json({ error: "Incident filing lease is no longer active" }, { status: 409 });
  }
  return Response.json({ ok: true, retry: true });
}

async function requeueBlockedIncidents() {
  const updated = await env.DB.prepare(`UPDATE system_incidents SET status = 'pending',
    filing_attempts = 0, next_attempt_at = NULL, lease_owner = NULL, lease_token = NULL,
    lease_expires_at = NULL, last_filing_error = NULL WHERE status = 'blocked'`).run();
  if ((updated.meta.changes ?? 0) > 0) {
    await env.DB.prepare("INSERT INTO activity (message, tone) VALUES (?, 'info')")
      .bind(`The system incident watcher requeued ${updated.meta.changes} previously blocked incident(s).`).run();
  }
  return { ok: true, requeued: updated.meta.changes ?? 0 };
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    if (!bridgeAuthorized(request)) return Response.json({ error: "Runtime bridge authorization failed" }, { status: 403 });
    const body = await request.json() as Record<string, unknown>;
    const workerId = cleanIdentifier(body.workerId);
    if (!workerId) return Response.json({ error: "A watcher identity is required" }, { status: 400 });
    const action = String(body.action ?? "");
    if (action === "claimIncident") return Response.json({ incident: await claimIncident(workerId) });
    if (action === "completeIncident") return await completeIncident(workerId, body);
    if (action === "failIncident") return await failIncident(workerId, body);
    if (action === "requeueBlocked") return Response.json(await requeueBlockedIncidents());
    return Response.json({ error: "Unknown incident action" }, { status: 400 });
  } catch {
    return Response.json({ error: "System incident action failed" }, { status: 500 });
  }
}
