import { runtimeStatusLabels, statusLabels, type CompanyState, type Employee } from "@/lib/company";
import { officeZoneForStatus } from "./LiveOffice";

interface EmployeeInspectorProps {
  employee: Employee;
  company: CompanyState;
  onClose: () => void;
}

function formatCompanyTime(value: string | null) {
  if (!value) return "No heartbeat yet";
  return new Date(`${value.endsWith("Z") ? value : `${value}Z`}`).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function EmployeeInspector({ employee, company, onClose }: EmployeeInspectorProps) {
  const runs = company.runs.filter((run) => run.employeeId === employee.id);
  const activeRun = runs.find((run) => ["claimed", "running"].includes(run.status)) ?? runs[0];
  const currentTask = company.tasks.find((task) => task.id === employee.currentTaskId)
    ?? company.tasks.find((task) => task.id === activeRun?.taskId);
  const events = activeRun ? company.runEvents.filter((event) => event.runId === activeRun.id).slice(0, 10) : [];
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
        <span className="eyebrow">CURRENT JOB</span>
        <h3>{currentTask?.title ?? "No assigned job"}</h3>
        <p>{currentTask?.brief || (activeRun?.promptSummary ?? "This employee is available for work.")}</p>
        {activeRun ? <div className="run-summary">
          <span className={`run-status run-${activeRun.status}`}>{activeRun.status.replace("_", " ")}</span>
          <b>Attempt {activeRun.attempt}</b>
          <small>Heartbeat {formatCompanyTime(activeRun.heartbeatAt)}</small>
          <p>{activeRun.lastEvent}</p>
          {activeRun.resultSummary ? <blockquote>{activeRun.resultSummary}</blockquote> : null}
          {activeRun.error ? <p className="run-error">{activeRun.error}</p> : null}
        </div> : null}
      </section>

      <section className="inspector-section">
        <span className="eyebrow">EXECUTION TRACE</span>
        <ol className="run-event-list">
          {events.map((event) => <li key={event.id}><i /><div><b>{event.message}</b><time>{formatCompanyTime(event.createdAt)}</time></div></li>)}
          {events.length === 0 ? <li className="empty-trace">No executor events recorded yet.</li> : null}
        </ol>
      </section>

      <section className="inspector-section inspector-authority">
        <span className="eyebrow">AUTHORITY & TRAINING</span>
        <p>{employee.resourceAccess} / {employee.workspacePolicy} workspace / {employee.employmentType}</p>
        <div>{employee.skills.length ? employee.skills.map((skill) => <span key={skill.id}>{skill.name}</span>) : <span>Base image only</span>}</div>
      </section>

      <footer>Dorothy reads this same D1-backed run evidence when preparing a CEO briefing.</footer>
    </aside>
  </div>;
}
