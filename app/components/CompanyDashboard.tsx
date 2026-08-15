"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { EmployeeSprite } from "./EmployeeSprite";
import {
  employeeStatuses,
  statusLabels,
  taskStatuses,
  type AnimationMapping,
  type CompanyState,
  type CompanyTask,
  type Employee,
  type TaskStatus,
} from "@/lib/company";

const columnCopy: Record<TaskStatus, { label: string; hint: string }> = {
  queued: { label: "Inbox", hint: "Ready for dispatch" },
  working: { label: "In progress", hint: "The company is moving" },
  review: { label: "Review", hint: "Check the result" },
  done: { label: "Shipped", hint: "Recently completed" },
};

const nextLabel: Partial<Record<TaskStatus, string>> = { queued: "Start", working: "Review", review: "Ship" };

interface HandoffFormProps {
  task: CompanyTask;
  contractor: Employee;
  accepted: boolean;
  busy: boolean;
  onSubmit: (payload: Record<string, unknown>, key: string) => Promise<void>;
}

function ContractorHandoffForm({ task, contractor, accepted, busy, onSubmit }: HandoffFormProps) {
  const [summary, setSummary] = useState("");
  const [deliverables, setDeliverables] = useState("");
  const [decisions, setDecisions] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [knowledge, setKnowledge] = useState("");

  if (accepted) return <p className="handoff-accepted">Handoff accepted / knowledge returned</p>;

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSubmit({
      action: "submitHandoff",
      taskId: task.id,
      employeeId: contractor.id,
      handoffKey: `handoff:${task.id}:${contractor.id}`,
      summary,
      deliverables,
      decisions,
      followUp,
      knowledge,
    }, `handoff-${task.id}`);
  }

  return <form className="handoff-form" onSubmit={submit}>
    <b>Contractor closeout</b>
    <textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What was completed?" rows={2} required />
    <textarea value={deliverables} onChange={(event) => setDeliverables(event.target.value)} placeholder="Deliverables and locations" rows={2} required />
    <textarea value={knowledge} onChange={(event) => setKnowledge(event.target.value)} placeholder="Reusable knowledge for the company" rows={2} required />
    <details><summary>Decisions and follow-up</summary>
      <textarea value={decisions} onChange={(event) => setDecisions(event.target.value)} placeholder="Important decisions" rows={2} />
      <textarea value={followUp} onChange={(event) => setFollowUp(event.target.value)} placeholder="Remaining work" rows={2} />
    </details>
    <button disabled={busy}>{busy ? "Submitting..." : "Submit handoff"}</button>
  </form>;
}

export function CompanyDashboard() {
  const [company, setCompany] = useState<CompanyState | null>(null);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [priority, setPriority] = useState("normal");
  const [assigneeId, setAssigneeId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectBrief, setProjectBrief] = useState("");
  const [projectManagerId, setProjectManagerId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/company", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as CompanyState & { error?: string };
        if (!response.ok) throw new Error(data.error || "Could not load the company");
        return data;
      })
      .then((data) => { if (!cancelled) setCompany(data); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, []);

  async function act(payload: Record<string, unknown>, key: string) {
    setBusy(key);
    setError("");
    try {
      const response = await fetch("/api/company", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json() as CompanyState & { error?: string };
      if (!response.ok) throw new Error(data.error || "The company could not complete that action");
      setCompany(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    await act({ action: "createTask", title, brief, priority, assigneeId, projectId }, "create");
    setTitle("");
    setBrief("");
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    await act({ action: "createProject", name: projectName, brief: projectBrief, managerId: projectManagerId }, "create-project");
    setProjectName("");
    setProjectBrief("");
  }

  const employee = company?.employees.find((item) => item.id === "employee-hrm") ?? company?.employees[0];
  const mapping = useMemo<AnimationMapping | undefined>(
    () => company?.mappings.find((item) => item.employeeStatus === employee?.status),
    [company?.mappings, employee?.status],
  );
  const currentTask = company?.tasks.find((task) => task.id === employee?.currentTaskId);
  const counts = useMemo(() => ({
    queued: company?.tasks.filter((task) => task.status === "queued").length ?? 0,
    active: company?.tasks.filter((task) => task.status === "working").length ?? 0,
    review: company?.tasks.filter((task) => task.status === "review").length ?? 0,
    done: company?.tasks.filter((task) => task.status === "done").length ?? 0,
  }), [company?.tasks]);

  if (!company) return <main className="loading-room"><span className="pixel-loader" /> Waking the company...</main>;

  const taskEmployees = company.employees.filter((item) => item.resourceAccess !== "read-all");
  const projectManagers = company.employees.filter((item) => item.roleProfileId === "project-manager");

  return (
    <main className="dashboard-shell">
      <section className="command-hero">
        <div>
          <span className="eyebrow">CEO COMMAND LINE</span>
          <h1>What should the company<br />accomplish next?</h1>
          <p>Set the direction. Assign real ownership. Contractors cannot close without a handoff.</p>
        </div>
        <form className="command-form" onSubmit={createTask}>
          <label htmlFor="task-command">New company objective</label>
          <div className="command-input-row">
            <span aria-hidden="true">&gt;</span>
            <input id="task-command" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ship the next useful thing..." maxLength={120} />
            <select aria-label="Task priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
            </select>
            <button disabled={busy === "create" || !title.trim()}>{busy === "create" ? "Adding..." : "Dispatch"}</button>
          </div>
          <div className="command-detail-row">
            <textarea aria-label="Task brief" value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="Definition of done, constraints, and context" rows={2} />
            <select aria-label="Task assignee" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
              <option value="">Choose assignee</option>
              {taskEmployees.map((item) => <option key={item.id} value={item.id}>{item.name} / {item.role}</option>)}
            </select>
            <select aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">No project</option>
              {company.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>
      </section>

      <section className="metric-strip" aria-label="Company metrics">
        <article><span className="metric-icon queued">IN</span><div><b>{counts.queued}</b><small>In the inbox</small></div></article>
        <article><span className="metric-icon active">GO</span><div><b>{counts.active}</b><small>In progress</small></div></article>
        <article><span className="metric-icon review">QA</span><div><b>{counts.review}</b><small>Needs review</small></div></article>
        <article><span className="metric-icon done">OK</span><div><b>{counts.done}</b><small>Shipped</small></div></article>
      </section>

      <section className="workspace-grid">
        <div className="office-panel panel">
          <div className="panel-heading"><div><span className="eyebrow">LIVE FLOOR</span><h2>The office</h2></div><span className="live-chip"><i /> live</span></div>
          <div className="pixel-office">
            <div className="office-window"><i /><i /><i /></div>
            <div className="wall-note note-one">SHIP</div><div className="wall-note note-two">LEARN</div>
            <div className="pixel-plant"><i /><i /><b /></div><div className="pixel-rug" />
            <div className="desk"><div className="monitor"><span>WORK<br />LOG</span></div><div className="mug" /><i /><i /></div>
            <div className="employee-station">
              <div className="speech-bubble">{currentTask?.title ?? statusLabels[employee?.status ?? "idle"]}</div>
              <EmployeeSprite animation={mapping?.animationState ?? "idle"} speedMs={mapping?.speedMs} size="large" spritesheetPath={employee?.spritesheetPath} label={`${employee?.name ?? "Employee"} character`} />
              <div className="employee-nameplate"><b>{employee?.name}</b><span>{employee?.role}</span></div>
            </div>
            {employee && <div className="office-status-card">
              <span>STATUS</span><b><i className={`status-dot status-${employee.status}`} /> {statusLabels[employee.status]}</b>
              <label htmlFor="employee-status">Preview employee state</label>
              <select id="employee-status" value={employee.status} disabled={busy === "employee-status"} onChange={(event) => act({ action: "setEmployeeStatus", employeeId: employee.id, status: event.target.value }, "employee-status") }>
                {employeeStatuses.map((status) => <option value={status} key={status}>{statusLabels[status]}</option>)}
              </select>
            </div>}
          </div>
        </div>

        <aside className="activity-panel panel">
          <div className="panel-heading compact"><div><span className="eyebrow">COMPANY FEED</span><h2>Activity</h2></div></div>
          <ol className="activity-list">
            {company.activity.map((item) => <li key={item.id}><i className={`activity-mark tone-${item.tone}`} /><div><p>{item.message}</p><time>{new Date(`${item.createdAt}Z`).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div></li>)}
          </ol>
        </aside>
      </section>

      <section className="corporate-grid">
        <article className="panel project-panel">
          <div className="panel-heading compact"><div><span className="eyebrow">PROJECT OFFICE</span><h2>Public project registry</h2></div></div>
          <form className="project-form" onSubmit={createProject}>
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Project name" required />
            <textarea value={projectBrief} onChange={(event) => setProjectBrief(event.target.value)} placeholder="Purpose, users, scope, and initial outcome" rows={3} required />
            <select value={projectManagerId} onChange={(event) => setProjectManagerId(event.target.value)}>
              <option value="">PM not onboarded yet</option>
              {projectManagers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
            </select>
            <button className="secondary-action" disabled={busy === "create-project"}>{busy === "create-project" ? "Recording..." : "Record planned project"}</button>
          </form>
          <p className="policy-note">Every repository is planned as public under VincentL01. Recording it here does not use your GitHub credential or create the repository.</p>
          <div className="project-list">{company.projects.map((project) => <div key={project.id}><b>{project.name}</b><span>{project.githubOwner} / {project.visibility} / {project.status}</span><small>{project.brief}</small>{project.repositoryUrl ? <a href={project.repositoryUrl} target="_blank" rel="noreferrer">Open repository</a> : project.status === "planned" ? <button className="secondary-action" disabled={busy === project.id} onClick={() => act({ action: "approveProject", projectId: project.id }, project.id)}>Approve public repository</button> : <em>Awaiting assigned Project Manager provisioning</em>}</div>)}</div>
        </article>

        <article className="panel knowledge-panel">
          <div className="panel-heading compact"><div><span className="eyebrow">COMPANY MEMORY</span><h2>Knowledge base</h2></div><b>{company.knowledge.length}</b></div>
          <div className="knowledge-list">{company.knowledge.map((entry) => <div key={entry.id}><span className={`knowledge-status ${entry.status}`}>{entry.status}</span><b>{entry.title}</b><p>{entry.summary}</p><small>{entry.sourceType}{entry.sourceRef ? ` / ${entry.sourceRef}` : ""}</small></div>)}</div>
        </article>
      </section>

      <section className="task-section">
        <div className="section-heading"><div><span className="eyebrow">OPERATIONS</span><h2>Company task board</h2></div><p>All work has an owner. Contractor knowledge returns to the company before shipping.</p></div>
        <div className="task-board">
          {taskStatuses.map((status) => <section className={`task-column column-${status}`} key={status}>
            <header><div><span>{columnCopy[status].label}</span><small>{columnCopy[status].hint}</small></div><b>{company.tasks.filter((task) => task.status === status).length}</b></header>
            <div className="task-stack">
              {company.tasks.filter((task) => task.status === status).map((task) => {
                const contractor = company.employees.find((item) => item.id === task.assigneeId);
                const accepted = company.handoffs.some((handoff) => handoff.taskId === task.id && handoff.status === "accepted");
                const project = company.projects.find((item) => item.id === task.projectId);
                return <article className="task-card" key={task.id}>
                  <div className="task-meta"><span className={`priority priority-${task.priority}`}>{task.priority}</span><span>{contractor?.name ?? "Unassigned"}</span></div>
                  <h3>{task.title}</h3>{task.brief && <p>{task.brief}</p>}
                  {project ? <small className="task-project">Project / {project.name}</small> : null}
                  {task.handoffRequired ? <span className="handoff-chip">Contractor handoff required</span> : null}
                  {status === "review" && contractor?.employmentType === "contractor" ? <ContractorHandoffForm task={task} contractor={contractor} accepted={accepted} busy={busy === `handoff-${task.id}`} onSubmit={act} /> : null}
                  {nextLabel[status] && <button disabled={busy === task.id || (status === "review" && task.handoffRequired && !accepted)} onClick={() => act({ action: "advanceTask", taskId: task.id }, task.id)}>{busy === task.id ? "Moving..." : nextLabel[status]} <span>-&gt;</span></button>}
                </article>;
              })}
              {!company.tasks.some((task) => task.status === status) && <div className="empty-column">Nothing here yet</div>}
            </div>
          </section>)}
        </div>
      </section>
    </main>
  );
}
