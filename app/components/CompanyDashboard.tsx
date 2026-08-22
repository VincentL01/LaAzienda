"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { EmployeeInspector } from "./EmployeeInspector";
import { LiveOffice } from "./LiveOffice";
import {
  codexAuthenticationRequiredMessage,
  githubAuthenticationRequiredMessage,
  taskStatuses,
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

const nextLabel: Partial<Record<TaskStatus, string>> = { review: "Accept & ship" };

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
  const [secretaryQuestion, setSecretaryQuestion] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const response = await fetch("/api/company", { cache: "no-store" });
        const data = await response.json() as CompanyState & { error?: string };
        if (!response.ok) throw new Error(data.error || "Could not load the company");
        if (!cancelled) { setCompany(data); setError(""); }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load the company");
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 4000);
      }
    }
    void refresh();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
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

  async function askSecretary(event: FormEvent) {
    event.preventDefault();
    if (!secretaryQuestion.trim()) return;
    await act({ action: "askSecretary", question: secretaryQuestion }, "ask-secretary");
    setSecretaryQuestion("");
  }

  const counts = useMemo(() => ({
    queued: company?.tasks.filter((task) => task.status === "queued").length ?? 0,
    active: company?.tasks.filter((task) => task.status === "working").length ?? 0,
    review: company?.tasks.filter((task) => task.status === "review").length ?? 0,
    done: company?.tasks.filter((task) => task.status === "done").length ?? 0,
  }), [company?.tasks]);

  if (!company) return <main className="loading-room"><span className="pixel-loader" /> Waking the company...</main>;

  const taskEmployees = company.employees.filter((item) => !["read-all", "docker-provisioner"].includes(item.resourceAccess));
  const projectManagers = company.employees.filter((item) => item.roleProfileId === "project-manager");
  const selectedEmployee = company.employees.find((item) => item.id === selectedEmployeeId) ?? null;
  const authenticationBlocked = company.tasks.some((task) => task.status === "review"
    && company.runs.find((run) => run.taskId === task.id)?.error === codexAuthenticationRequiredMessage)
    || company.secretaryInquiries.some((inquiry) => inquiry.status === "failed"
      && company.runs.find((run) => run.jobType === "secretary-inquiry" && run.jobId === inquiry.id)?.error === codexAuthenticationRequiredMessage);
  const githubAuthenticationBlocked = company.tasks.some((task) => task.status === "review"
    && company.runs.find((run) => run.taskId === task.id)?.error === githubAuthenticationRequiredMessage);
  const unresolvedSystemIncident = company.systemIncidents.find((incident) => ["pending", "filing", "blocked"].includes(incident.status));
  const latestRepositorySync = company.repositorySyncs[0] ?? null;

  return (
    <main className="dashboard-shell">
      <section className="command-hero">
        <div>
          <span className="eyebrow">CEO COMMAND LINE</span>
          <h1>What should the company<br />accomplish next?</h1>
          <p>Set the direction. Aurelia provisions the owner, Codex executes, and every result returns with evidence.</p>
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
              <option value="">Auto-assign Project Manager</option>
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

      <section className="source-sync" aria-label="Repository synchronization status">
        <span className="source-sync-label"><i /> SOURCE WATCHER</span>
        {latestRepositorySync ? <>
          <b>main @ {latestRepositorySync.commitSha.slice(0, 7)}</b>
          <small>PR #{latestRepositorySync.pullNumber} from {latestRepositorySync.sourceBranch} synchronized {new Date(`${latestRepositorySync.syncedAt}Z`).toLocaleString()}</small>
        </> : <>
          <b>Watching VincentL01/LaAzienda</b>
          <small>A clean merged codex/* branch will switch to main, pull fast-forward-only, and refresh the company.</small>
        </>}
      </section>

      {authenticationBlocked ? <section className="company-alert" role="status">
        <b>Codex sign-in needs CEO attention</b>
        <p>Replace the ignored <code>assets/agent_auth/auth.json</code> with a fresh authenticated session. Aurelia detects the saved file within five seconds, refreshes affected employee containers, and retries only authentication-blocked work.</p>
      </section> : null}

      {githubAuthenticationBlocked ? <section className="company-alert" role="status">
        <b>GitHub sign-in needs CEO attention</b>
        <p>Run <code>runtime/Import-GitHubCredential.ps1</code> on the host. It securely imports the existing VincentL01 Git Credential Manager identity, refreshes only the Project Manager credential boundary, and never exposes the credential in the portal.</p>
      </section> : null}

      {unresolvedSystemIncident ? <section className="company-alert" role="status">
        <b>Company Portal incident {unresolvedSystemIncident.status}</b>
        <p>{unresolvedSystemIncident.summary} Select {company.employees.find((employee) => employee.id === unresolvedSystemIncident.employeeId)?.name ?? "the linked employee"} to inspect the run evidence{unresolvedSystemIncident.lastFilingError ? ` and retry status: ${unresolvedSystemIncident.lastFilingError}` : unresolvedSystemIncident.status === "blocked" ? " and the recorded filing blocker" : " while the host files and verifies the GitHub issue"}.</p>
      </section> : null}

      <section className="workspace-grid">
        <div className="office-panel panel">
          <div className="panel-heading"><div><span className="eyebrow">LIVE FLOOR</span><h2>The company campus</h2></div><div className="office-heading-actions"><span className="live-chip"><i /> D1 live</span><small>Select an employee to inspect the live job, heartbeat, and execution trace.</small></div></div>
          <LiveOffice
            employees={company.employees}
            tasks={company.tasks}
            runs={company.runs}
            mappings={company.mappings}
            selectedEmployeeId={selectedEmployeeId}
            onSelectEmployee={setSelectedEmployeeId}
          />
        </div>

        <aside className="activity-panel panel">
          <div className="panel-heading compact"><div><span className="eyebrow">SECRETARY DESK</span><h2>Ask Dorothy</h2></div></div>
          <form className="secretary-form" onSubmit={askSecretary}>
            <label htmlFor="secretary-question">Ask about any employee, job, heartbeat, or blocker</label>
            <textarea id="secretary-question" rows={3} value={secretaryQuestion} onChange={(event) => setSecretaryQuestion(event.target.value)} placeholder="What is happening with the LaAzienda improvement job?" />
            <button className="secondary-action" disabled={busy === "ask-secretary" || !secretaryQuestion.trim()}>{busy === "ask-secretary" ? "Queuing..." : "Ask for live briefing"}</button>
          </form>
          <div className="secretary-answers">
            {company.secretaryInquiries.slice(0, 3).map((inquiry) => <article key={inquiry.id}>
              <span className={`run-status run-${inquiry.status}`}>{inquiry.status}</span>
              <b>{inquiry.question}</b>
              <p>{inquiry.answer || (inquiry.status === "running"
                ? "Dorothy is reading the company record now."
                : inquiry.status === "failed"
                  ? "Dorothy could not complete the briefing. Open her personnel file for the recorded blocker."
                  : "Waiting for Aurelia to dispatch Dorothy.")}</p>
            </article>)}
          </div>
          <div className="panel-heading compact activity-subheading"><div><span className="eyebrow">COMPANY FEED</span><h2>Activity</h2></div></div>
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
                const latestRun = company.runs.find((run) => run.taskId === task.id);
                const accepted = company.handoffs.some((handoff) => handoff.taskId === task.id && handoff.status === "accepted");
                const project = company.projects.find((item) => item.id === task.projectId);
                return <article className="task-card" key={task.id}>
                  <div className="task-meta"><span className={`priority priority-${task.priority}`}>{task.priority}</span><span>{contractor?.name ?? "Unassigned"}</span></div>
                  <h3>{task.title}</h3>{task.brief && <p>{task.brief}</p>}
                  {project ? <small className="task-project">Project / {project.name}</small> : null}
                  {task.handoffRequired ? <span className="handoff-chip">Contractor handoff required</span> : null}
                  {latestRun ? <div className="task-run-line"><span className={`run-status run-${latestRun.status}`}>{latestRun.status.replace("_", " ")}</span><small>{latestRun.lastEvent}</small></div> : null}
                  {latestRun?.error ? <small className="run-error">{latestRun.error}</small> : null}
                  {status === "queued" && !contractor ? <label className="task-assigner">Assign for execution
                    <select defaultValue="" onChange={(event) => {
                      if (event.target.value) void act({ action: "assignTask", taskId: task.id, assigneeId: event.target.value }, `assign-${task.id}`);
                    }} disabled={busy === `assign-${task.id}`}>
                      <option value="">Choose employee</option>
                      {taskEmployees.map((item) => <option key={item.id} value={item.id}>{item.name} / {item.role}</option>)}
                    </select>
                  </label> : null}
                  {status === "queued" && contractor ? <p className="executor-note">Queued for Aurelia’s dispatcher. The container will start automatically.</p> : null}
                  {status === "working" ? <p className="executor-note">Live execution is owned by the agent runner; board movement is automatic.</p> : null}
                  {status === "review" && contractor?.employmentType === "contractor" ? <ContractorHandoffForm task={task} contractor={contractor} accepted={accepted} busy={busy === `handoff-${task.id}`} onSubmit={act} /> : null}
                  {status === "review" && latestRun?.resultSummary ? <blockquote className="task-result">{latestRun.resultSummary}</blockquote> : null}
                  {status === "review" && ["failed", "needs_input"].includes(latestRun?.status ?? "") ? <button disabled={busy === `retry-${task.id}`} onClick={() => act({ action: "retryTask", taskId: task.id }, `retry-${task.id}`)}>{busy === `retry-${task.id}` ? "Queuing..." : "Retry with employee"}</button> : null}
                  {nextLabel[status] && <button disabled={busy === task.id || latestRun?.status !== "completed" || (status === "review" && task.handoffRequired && !accepted)} onClick={() => act({ action: "advanceTask", taskId: task.id }, task.id)}>{busy === task.id ? "Moving..." : nextLabel[status]} <span>-&gt;</span></button>}
                </article>;
              })}
              {!company.tasks.some((task) => task.status === status) && <div className="empty-column">Nothing here yet</div>}
            </div>
          </section>)}
        </div>
      </section>
      {selectedEmployee ? <EmployeeInspector employee={selectedEmployee} company={company} onClose={() => setSelectedEmployeeId(null)} /> : null}
    </main>
  );
}
