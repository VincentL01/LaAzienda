"use client";

import { FormEvent, useEffect, useState } from "react";
import type { TrainingCenterState } from "@/lib/company";

function formatCompanyTime(value: string | null) {
  if (!value) return "Waiting for HRM";
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? "Not recorded" : parsed.toLocaleString();
}

export function TrainingCenter() {
  const [training, setTraining] = useState<TrainingCenterState | null>(null);
  const [query, setQuery] = useState("");
  const [packageRef, setPackageRef] = useState("");
  const [skillName, setSkillName] = useState("");
  const [petSlug, setPetSlug] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [skillId, setSkillId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [credential, setCredential] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch("/api/training", { cache: "no-store" });
        const data = await response.json() as TrainingCenterState & { error?: string; locked?: boolean };
        if (response.status === 403 && data.locked) {
          if (!cancelled) { setTraining(null); setLocked(true); setError(""); }
          return;
        }
        if (!response.ok) throw new Error(data.error || "Could not open the Training Center");
        if (!cancelled) { setTraining(data); setLocked(false); setError(""); }
      } catch (reason) {
        if (!cancelled) {
          setTraining(null);
          setLocked(false);
          setError(reason instanceof Error ? reason.message : "Could not open the Training Center");
        }
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [reloadKey]);

  async function unlockOwner(event: FormEvent) {
    event.preventDefault();
    setBusy("unlock-owner");
    setActionError("");
    try {
      const response = await fetch("/api/owner-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      const data = await response.json() as { authorized?: boolean; error?: string };
      if (!response.ok || !data.authorized) throw new Error(data.error || "CEO authorization failed");
      setReloadKey((value) => value + 1);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "CEO authorization failed");
    } finally {
      setCredential("");
      setBusy("");
    }
  }

  async function act(payload: Record<string, unknown>, key: string) {
    setBusy(key);
    setActionError("");
    try {
      const response = await fetch("/api/training", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json() as TrainingCenterState & { error?: string };
      if (!response.ok) throw new Error(data.error || "Training Center action failed");
      setTraining(data);
      return true;
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Something went wrong");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function requestSkill(event: FormEvent) {
    event.preventDefault();
    const saved = await act({ action: "requestSkill", packageRef, name: skillName }, "request-skill");
    if (saved) { setPackageRef(""); setSkillName(""); }
  }

  async function requestPet(event: FormEvent) {
    event.preventDefault();
    const saved = await act({ action: "requestCharacter", slug: petSlug }, "request-pet");
    if (saved) setPetSlug("");
  }

  async function assignSkill(event: FormEvent) {
    event.preventDefault();
    await act({ action: "assignSkill", employeeId, skillId }, "assign-skill");
  }

  async function revokeSkill(employeeIdToRevoke: string, skillIdToRevoke: string) {
    await act({ action: "revokeSkill", employeeId: employeeIdToRevoke, skillId: skillIdToRevoke }, `revoke:${employeeIdToRevoke}:${skillIdToRevoke}`);
  }

  async function lockOwner() {
    setBusy("lock-owner");
    setActionError("");
    try {
      const response = await fetch("/api/owner-session", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not lock CEO controls");
      setTraining(null);
      setLocked(true);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Could not lock CEO controls");
    } finally {
      setBusy("");
    }
  }

  const ownerUnlockPanel = <form className="owner-unlock panel" onSubmit={unlockOwner}>
    <div><span className="eyebrow">CEO CONTROL</span><h2>Training controls are locked</h2><p>Run <code>runtime/Copy-CompanyOwnerCredential.ps1</code> on this machine, then paste the copied company-owner credential below. It is not the runtime bridge token and never enters Docker configuration; this form clears it immediately after creating an opaque eight-hour HttpOnly session.</p></div>
    <label htmlFor="owner-credential">
      <span>Company owner credential</span>
      <input id="owner-credential" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Paste the copied credential" aria-describedby="owner-credential-help" value={credential} onChange={(event) => setCredential(event.target.value)} required />
      <small id="owner-credential-help">Paste the credential to enable the unlock button.</small>
    </label>
    <button type="submit" className="primary-action" disabled={busy === "unlock-owner" || !credential}>{busy === "unlock-owner" ? "Unlocking..." : "Unlock controls"}</button>
  </form>;

  if (!training && error) return <main className="loading-room"><div><b>The Training Center is unavailable.</b><p className="studio-error" role="alert">{error}</p><button className="primary-action" onClick={() => setReloadKey((value) => value + 1)}>Retry</button></div></main>;
  if (!training && locked) return <main className="training-shell">
    <section className="training-hero">
      <div><span className="eyebrow">GLOBAL TRAINING CENTER</span><h1>Learn once.<br />Teach the whole company.</h1></div>
      <p>Company training records remain hidden until the CEO owner session is unlocked.</p>
    </section>
    <div aria-live="polite">{actionError ? <p className="studio-error" role="alert">{actionError}</p> : null}</div>
    {ownerUnlockPanel}
  </main>;
  if (!training) return <main className="loading-room"><span className="pixel-loader" /> Opening the Training Center...</main>;

  return (
    <main className="training-shell">
      <section className="training-hero">
        <div><span className="eyebrow">GLOBAL TRAINING CENTER</span><h1>Learn once.<br />Teach the whole company.</h1></div>
        <ol className="training-loop"><li><b>1</b> Find a trusted skill</li><li><b>2</b> Cache its real files once</li><li><b>3</b> Assign copies to employees</li></ol>
      </section>
      <div aria-live="polite">{error ? <p className="studio-error" role="alert">{error}</p> : null}{actionError ? <p className="studio-error" role="alert">{actionError}</p> : null}</div>
      {!training.ownerAuthorized ? ownerUnlockPanel : <div className="owner-unlock panel"><div><span className="eyebrow">CEO CONTROL</span><h2>CEO controls unlocked (8h)</h2><p>This local HttpOnly owner session lasts up to eight hours.</p></div><button className="secondary-action" disabled={busy === "lock-owner"} onClick={lockOwner}>{busy === "lock-owner" ? "Locking..." : "Lock controls"}</button></div>}

      <section className="training-tools">
        <article className="tool-card panel">
          <div className="panel-heading compact"><div><span className="eyebrow">SKILL DISCOVERY</span><h2>Find online</h2></div></div>
          <div className="tool-body">
            <p>Search the public skill catalog, inspect its instructions, then submit the exact package reference below.</p>
            <label>What should an employee learn?<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. GitHub issue triage" /></label>
            <a className="secondary-action action-link" href={`https://skills.sh/?q=${encodeURIComponent(query)}`} target="_blank" rel="noreferrer">Search skills.sh</a>
            <code>{query ? `npx skills find ${query}` : training.discoveryCommand}</code>
          </div>
        </article>
        <form className="tool-card panel" onSubmit={requestSkill}>
          <div className="panel-heading compact"><div><span className="eyebrow">IMPORT DESK</span><h2>Queue a skill</h2></div></div>
          <div className="tool-body">
            <label>Display name<input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="React best practices" /></label>
            <label>Package reference or npx command<input value={packageRef} onChange={(event) => setPackageRef(event.target.value)} placeholder="npx skills add microsoft/skills@azure-ai-projects-ts -y" required /></label>
            <small>This records a D1 import request. Then run <code>training-center/Import-Skill.ps1 -PackageRef owner/repository@skill-name</code> locally and inspect SKILL.md; there is no automatic online installer yet.</small>
            <button className="primary-action" disabled={!training.ownerAuthorized || busy === "request-skill" || !packageRef.trim()}>{busy === "request-skill" ? "Recording..." : "Record import request"}</button>
          </div>
        </form>
        <form className="tool-card panel" onSubmit={requestPet}>
          <div className="panel-heading compact"><div><span className="eyebrow">CHARACTER DEPOT</span><h2>Queue a pet</h2></div></div>
          <div className="tool-body">
            <p>Choose an approved character without changing or recompressing its spritesheet.</p>
            <a href={training.petCatalogUrl} target="_blank" rel="noreferrer">Browse codex-pets.net</a>
            <label>Pet slug<input value={petSlug} onChange={(event) => setPetSlug(event.target.value)} placeholder="character-slug" required /></label>
            <small>This records a D1 request. Then run <code>training-center/Import-Character.ps1 -Slug character-slug</code> locally; character imports are not automated yet.</small>
            <button className="primary-action" disabled={!training.ownerAuthorized || busy === "request-pet" || !petSlug.trim()}>{busy === "request-pet" ? "Queuing..." : "Queue character import"}</button>
          </div>
        </form>
      </section>

      <section className="cache-section">
        <div className="section-heading"><div><span className="eyebrow">APPROVED KNOWLEDGE</span><h2>Skill cache</h2></div><p>Confirmation records that the master ran the local import script and inspected the resulting SKILL.md.</p></div>
        <div className="cache-grid">
          {training.skills.map((skill) => <article className="cache-card" key={skill.id}>
            <div><span className={`cache-badge cache-${skill.cacheStatus}`}>{skill.cacheStatus}</span><h3>{skill.name}</h3><p>{skill.packageRef}</p><small>{skill.description}</small></div>
            <code>{skill.installCommand}</code>
            {skill.observationStatus === "observed" && skill.observedDigest
              ? <div><small>Observed {skill.observedAt ? `at ${formatCompanyTime(skill.observedAt)}` : "time unavailable"}</small><code className="full-digest">SHA-256 {skill.observedDigest}</code></div>
              : skill.observationStatus === "missing" || skill.observationStatus === "failed"
                ? <small className="training-evidence">{skill.observationEvidence || "Aurelia could not verify this cache folder."} {skill.observedAt ? `Observed ${formatCompanyTime(skill.observedAt)}.` : ""}</small>
                : <small>Waiting for Aurelia&apos;s first host-side cache observation.</small>}
            {skill.approvedDigest === skill.observedDigest && skill.approvedDigest
              ? <span className="ready-note">Approved revision {skill.approvalVersion}{skill.approvedAt ? ` at ${formatCompanyTime(skill.approvedAt)}` : ""} · ready to assign</span>
              : <button className="secondary-action" disabled={!training.ownerAuthorized || busy === skill.id || !skill.observedDigest} onClick={() => act({ action: "approveSkillCache", skillId: skill.id, expectedObservedDigest: skill.observedDigest }, skill.id)}>{busy === skill.id ? "Approving..." : "Approve this exact digest"}</button>}
          </article>)}
          {!training.skills.length ? <div className="empty-cache">No skills have been requested yet.</div> : null}
        </div>
      </section>

      <section className="cache-section training-records">
        <div className="section-heading"><div><span className="eyebrow">EMPLOYEE CURRICULUM</span><h2>Teach an employee</h2></div><p>D1 records the desired assignment first. Aurelia then syncs the reviewed files and records independent SHA-256 read-back evidence.</p></div>
        <form className="training-assignment-form panel" onSubmit={assignSkill}>
          <label>Employee
            <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required>
              <option value="">Choose an employee</option>
              {training.employees.filter((employee) => employee.id !== "employee-hrm").map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.role}</option>)}
            </select>
          </label>
          <label>Cached skill
            <select value={skillId} onChange={(event) => setSkillId(event.target.value)} required>
              <option value="">Choose a skill</option>
              {training.skills.filter((skill) => skill.cacheStatus === "cached").map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
            </select>
          </label>
          <button className="primary-action" disabled={!training.ownerAuthorized || busy === "assign-skill" || !employeeId || !skillId}>{busy === "assign-skill" ? "Assigning..." : "Assign training"}</button>
        </form>

        <div className="training-assignment-grid">
          {training.assignments.map((assignment) => <article className="training-assignment-card" key={`${assignment.employeeId}:${assignment.skillId}`}>
            <header><div><b>{assignment.employeeName}</b><small>{assignment.skillName} · {assignment.desiredOperation}</small></div><span className={`training-state training-${assignment.status}`}>{assignment.status}</span></header>
            <p>{assignment.packageRef}</p>
            <dl>
              <div><dt>{assignment.desiredOperation === "remove" ? "Removal requested" : "Assigned"}</dt><dd>{formatCompanyTime(assignment.desiredOperation === "remove" ? assignment.desiredUpdatedAt : assignment.assignedAt)}</dd></div>
              <div><dt>{assignment.status === "verified" ? "Verified" : assignment.lastAttemptAt ? "Observed at" : "Execution"}</dt><dd>{assignment.lastAttemptAt ? formatCompanyTime(assignment.status === "verified" ? assignment.verifiedAt ?? assignment.lastAttemptAt : assignment.lastAttemptAt) : "Not attempted yet"}</dd></div>
              <div><dt>Recorded observations</dt><dd>{assignment.attempts}</dd></div>
            </dl>
            <small className="training-evidence">{assignment.evidence}</small>
            {assignment.verifiedHash ? <code title={assignment.verifiedHash}>SHA-256 {assignment.verifiedHash.slice(0, 16)}…</code> : null}
            {assignment.desiredOperation === "install" ? <button className="secondary-action" disabled={!training.ownerAuthorized || busy === `revoke:${assignment.employeeId}:${assignment.skillId}`} onClick={() => revokeSkill(assignment.employeeId, assignment.skillId)}>{busy === `revoke:${assignment.employeeId}:${assignment.skillId}` ? "Revoking..." : "Revoke training"}</button> : <span className="ready-note">Removal requested</span>}
          </article>)}
          {!training.assignments.length ? <div className="empty-cache">No employee training has been assigned yet.</div> : null}
        </div>
      </section>

      <section className="cache-section training-history-section">
        <div className="section-heading"><div><span className="eyebrow">AUDIT LEDGER</span><h2>Training history</h2></div><p>Latest 100 durable observations. For installs, “verified” means the approved cache, HRM-staged volume, and separate active-volume read-back matched; for removals, it means an independent read-back proved the managed path absent.</p></div>
        {/* Scrollable audit evidence must be keyboard-focusable. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="training-history" role="region" aria-label="Employee training history, latest 100 observations" tabIndex={0} aria-live="polite">
          <table>
            <thead><tr><th>Employee</th><th>Skill</th><th>Operation</th><th>Version</th><th>Status</th><th>Observation</th><th>When</th><th>Evidence</th></tr></thead>
            <tbody>
              {training.history.map((event) => <tr key={event.id}>
                <td>{event.employeeName}</td><td>{event.skillName}</td><td>{event.operation}</td>
                <td>Assignment {event.assignmentVersion}<br />Manifest <code title={event.manifestVersion ?? "No manifest"}>{event.manifestVersion?.slice(0, 10) ?? "none"}</code></td>
                <td><span className={`training-state training-${event.status}`}>{event.status}</span></td>
                <td>{event.attempts} · {event.workerId}</td>
                <td>{formatCompanyTime(event.status === "verified" ? event.verifiedAt ?? event.updatedAt : event.updatedAt)}</td>
                <td><details><summary>{event.evidence}</summary><dl><div><dt>Cache</dt><dd><code>{event.sourceHash ?? "none"}</code></dd></div><div><dt>Staged volume</dt><dd><code>{event.stagedHash ?? "none"}</code></dd></div><div><dt>Workspace</dt><dd><code>{event.verifiedHash ?? "none"}</code></dd></div></dl></details></td>
              </tr>)}
              {!training.history.length ? <tr><td colSpan={8}>No sync observations have been recorded.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cache-section">
        <div className="section-heading"><div><span className="eyebrow">CHARACTER LIBRARY</span><h2>Avatar cache</h2></div><p>Pet packages remain byte-for-byte intact in assets/characters and are copied to public assets for the office renderer.</p></div>
        <div className="cache-grid">
          {training.characters.map((character) => <article className="cache-card" key={character.id}>
            <div><span className={`cache-badge cache-${character.cacheStatus}`}>{character.cacheStatus}</span><h3>{character.displayName}</h3><p>{character.id} / Codex Pet v{character.spriteVersion}</p></div>
            {character.installCommand ? <code>{character.installCommand}</code> : <code>Owner-provided local pack</code>}
            {character.cacheStatus !== "cached" ? <small>Next: run <code>training-center/Import-Character.ps1 -Slug {character.id}</code> on the host, then inspect the untouched pack.</small> : null}
            {character.cacheStatus !== "cached" ? <button className="secondary-action" disabled={!training.ownerAuthorized || busy === character.id} onClick={() => act({ action: "confirmCharacterCached", slug: character.id }, character.id)}>Confirm local cache</button> : <span className="ready-note">Ready for onboarding</span>}
          </article>)}
        </div>
      </section>
    </main>
  );
}
