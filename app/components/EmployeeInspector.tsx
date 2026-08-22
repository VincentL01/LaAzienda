import { useEffect, useState } from "react";
import { runtimeStatusLabels, statusLabels, type CompanyState, type Employee } from "@/lib/company";
import { officeZoneForStatus } from "./LiveOffice";

interface EmployeeInspectorProps {
  employee: Employee;
  company: CompanyState;
  onClose: () => void;
}

function parseCompanyTime(value: string | null) {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatCompanyTime(value: string | null) {
  const parsed = parseCompanyTime(value);
  if (!parsed) return "Not recorded";
  return parsed.toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function EmployeeInspector({ employee, company, onClose }: EmployeeInspectorProps) {
  const [observedAt, setObservedAt] = useState<number | null>(null);
  useEffect(() => {
    const refreshClock = () => setObservedAt(Date.now());
    const firstTick = window.setTimeout(refreshClock, 0);
    const timer = window.setInterval(refreshClock, 1000);
    return () => { window.clearTimeout(firstTick); window.clearInterval(timer); };
  }, []);

  const runs = company.runs.filter((run) => run.employeeId === employee.id);
  const activeRun = runs.find((run) => ["claimed", "running"].includes(run.status));
  const latestRun = runs[0];
  const displayedRun = activeRun ?? latestRun;
  const currentTask = company.tasks.find((task) => task.id === employee.currentTaskId)
    ?? company.tasks.find((task) => task.id === activeRun?.taskId);
  const latestTask = latestRun?.taskId ? company.tasks.find((task) => task.id === latestRun.taskId) : undefined;
  const displayedTask = currentTask ?? latestTask;
  const events = displayedRun ? company.runEvents.filter((event) => event.runId === displayedRun.id).slice(0, 10) : [];
  const incidents = company.systemIncidents.filter((incident) => incident.employeeId === employee.id).slice(0, 5);
  const leaseExpiresAt = parseCompanyTime(activeRun?.leaseExpiresAt ?? null);
  const heartbeatState = activeRun
    ? !activeRun.heartbeatAt || !leaseExpiresAt
      ? "missing"
      : observedAt === null ? "checking" : leaseExpiresAt.getTime() <= observedAt ? "stale" : "live"
    : null;
  const heartbeatLabel = heartbeatState === "live"
    ? "Live heartbeat"
    : heartbeatState === "stale" ? "Stale heartbeat"
      : heartbeatState === "checking" ? "Checking heartbeat" : "Heartbeat missing";
  const showingCurrentWork = Boolean(currentTask || activeRun);
  const zone = officeZoneForStatus(employee.status);

  return <div className="employee-inspector-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <aside className="employee-inspector" role="dialog" aria-modal="true" aria-labelledby="employee-inspector-title">
      <header>
        <div><span className="eyebrow">LIVE PERSONNEL FILE</span><h2 id="employee-inspector-title">{employee.name}</h2><p>{employee.role} / {employee.department}</p></div>
        <button className="inspector-close" onClick={onClose} aria-label="Close employee details">×</button>
      </header>

      <div className="inspector-status-grid">
        <div><span>Employee</span><b><i className={`status-dot status-${employee.status}`} />{statusLabels[employee.status]}</b></div>
        <div><span>Docker</span><b>{runtimeStatusLabels[employee.runtimeStatus]}</b></div>
        <div><span>Room</span><b>{zone.name}</b></div>
        <div><span>Last runtime</span><b>{formatCompanyTime(employee.lastRuntimeAt)}</b></div>
      </div>

      <section className="inspector-section">
        <span className="eyebrow">{showingCurrentWork ? "CURRENT JOB" : displayedRun ? "LATEST RUN" : "CURRENT JOB"}</span>
        <h3>{displayedTask?.title ?? displayedRun?.promptSummary ?? "No assigned job"}</h3>
        <p>{displayedTask?.brief || displayedRun?.promptSummary || "This employee is available for work."}</p>
        {displayedRun ? <div className="run-summary">
          <span className={`run-status run-${displayedRun.status}`}>{displayedRun.status.replace("_", " ")}</span>
          <b>Attempt {displayedRun.attempt}</b>
          {activeRun ? <small className={`run-heartbeat heartbeat-${heartbeatState}`}>
            <i aria-hidden="true" />{heartbeatLabel} / {formatCompanyTime(activeRun.heartbeatAt)}
          </small> : <small>Finished {formatCompanyTime(displayedRun.finishedAt)}</small>}
          <p>{displayedRun.lastEvent}</p>
          {displayedRun.resultSummary ? <blockquote>{displayedRun.resultSummary}</blockquote> : null}
          {displayedRun.error ? <p className="run-error">{displayedRun.error}</p> : null}
        </div> : null}
      </section>

      <section className="inspector-section">
        <span className="eyebrow">{activeRun ? "LIVE EXECUTION TRACE" : "LATEST EXECUTION TRACE"}</span>
        <ol className="run-event-list">
          {events.map((event) => <li key={event.id}><i /><div><b>{event.message}</b><time>{formatCompanyTime(event.createdAt)}</time></div></li>)}
          {events.length === 0 ? <li className="empty-trace">No executor events recorded yet.</li> : null}
        </ol>
      </section>

      {incidents.length ? <section className="inspector-section">
        <span className="eyebrow">COMPANY PORTAL INCIDENTS</span>
        <div className="incident-list">
          {incidents.map((incident) => <article key={incident.id}>
            <div><span className={`incident-status incident-${incident.status}`}>{incident.status}</span><small>{incident.method} {incident.route} / {incident.occurrenceCount}×</small></div>
            <p>{incident.summary}</p>
            {incident.issueUrl ? <a href={incident.issueUrl} target="_blank" rel="noreferrer">Open verified GitHub issue #{incident.issueNumber}</a>
              : <small>{incident.lastFilingError
                ? `${incident.lastFilingError}${incident.nextAttemptAt ? ` Retry scheduled ${formatCompanyTime(incident.nextAttemptAt)}.` : ""}`
                : incident.status === "blocked" ? "Automatic issue filing is blocked." : "GitHub issue filing is pending."}</small>}
          </article>)}
        </div>
      </section> : null}

      <section className="inspector-section inspector-authority">
        <span className="eyebrow">AUTHORITY & TRAINING</span>
        <p>{employee.resourceAccess} / {employee.workspacePolicy} workspace / {employee.employmentType}</p>
        <div>{employee.skills.length ? employee.skills.map((skill) => <span key={skill.id}>{skill.name}</span>) : <span>Base image only</span>}</div>
      </section>

      <footer>Dorothy reads this same D1-backed run evidence when preparing a CEO briefing.</footer>
    </aside>
  </div>;
}
