"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import type { MailroomState } from "@/lib/company";

export function CompanyMailroom() {
  const [mailroom, setMailroom] = useState<MailroomState | null>(null);
  const [senderEmployeeId, setSenderEmployeeId] = useState("");
  const [recipientEmployeeId, setRecipientEmployeeId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [messageKey, setMessageKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/mail", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as MailroomState & { error?: string };
        if (!response.ok) throw new Error(data.error || "Could not open the mailroom");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setMailroom(data);
        const sender = data.employees.find((employee) => employee.resourceAccess !== "read-all");
        setSenderEmployeeId(sender?.id ?? "");
        setRecipientEmployeeId(data.employees.find((employee) => employee.id !== sender?.id)?.id ?? "");
      })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, []);

  function updateDraft(update: () => void) {
    update();
    setMessageKey("");
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const retryKey = messageKey || crypto.randomUUID();
    if (!messageKey) setMessageKey(retryKey);
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/mail", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "queueMail",
          senderEmployeeId,
          recipientEmployeeId,
          subject,
          body,
          messageKey: retryKey,
        }),
      });
      const data = await response.json() as MailroomState & { error?: string };
      if (!response.ok) throw new Error(data.error || "The message could not be queued");
      setMailroom(data);
      setSubject("");
      setBody("");
      setMessageKey("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Mailroom action failed");
    } finally {
      setBusy(false);
    }
  }

  if (!mailroom) return error
    ? <main className="loading-room"><div><b>Company mail is locked or unavailable.</b><p role="alert">{error}</p><Link href="/training">Unlock CEO controls in the Training Room</Link></div></main>
    : <main className="loading-room"><span className="pixel-loader" /> Opening the company mailroom...</main>;

  const dorothy = mailroom.employees.find((employee) => employee.id === "employee-dorothy");
  const senders = mailroom.employees.filter((employee) => employee.resourceAccess !== "read-all");
  const recipients = mailroom.employees.filter((employee) => employee.id !== senderEmployeeId);

  return (
    <main className="company-shell">
      <section className="company-hero">
        <div>
          <span className="eyebrow">COMPANY OPERATING SYSTEM</span>
          <h1>Give every request<br />a clear owner.</h1>
          <p>Aurelia governs the workforce, Project Managers coordinate delivery, and Dorothy keeps a read-only view for the CEO. Every employee starts from the same Codex base.</p>
        </div>
        <div className="mail-topology" aria-label="Mail topology">
          <span>CEO</span><i>→</i><b>PM / HRM</b><i>→</i><span>Stalwart</span><i>→</i><b>Employee</b>
          <small>Dorothy observes read-only · private Docker network · {mailroom.mailDomain}</small>
        </div>
      </section>

      {error ? <p className="studio-error" role="alert">{error}</p> : null}

      <section className="base-profile panel">
        <div className="panel-heading compact"><div><span className="eyebrow">BASE CHARACTER STATS</span><h2>{mailroom.runtimeProfile.imageTag}</h2></div><span className="cache-badge cache-cached">Codex base</span></div>
        <div className="base-profile-grid">
          <article><span>Brain</span><b>{mailroom.runtimeProfile.harness}</b><small>{mailroom.runtimeProfile.codexHome}</small></article>
          <article><span>Memory</span><b>Mounted workspace</b><small>{mailroom.runtimeProfile.workspacePath}</small></article>
          <article><span>Training</span><b>Skill overlays</b><small>{mailroom.runtimeProfile.skillsPath}</small></article>
          <article><span>Authority</span><b>Socket denied by default</b><small>Only the reviewed HRM extension receives it</small></article>
        </div>
        <footer className="base-tool-strip">{mailroom.runtimeProfile.baseTools.map((tool) => <code key={tool}>+ {tool}</code>)}</footer>
      </section>

      <section className="role-section">
        <div className="section-heading"><div><span className="eyebrow">ROLE CATALOG</span><h2>A small company, fully covered</h2></div><p>Role profiles seed the employee prompt. You can still tailor the job title and prompt during onboarding.</p></div>
        <div className="role-grid">
          {mailroom.roles.map((role) => <article className="role-card" key={role.id}>
            <header><span>{role.department}</span><b>{role.employmentType}</b></header>
            <h3>{role.title}</h3>
            <p>{role.mission}</p>
            <div><code>{role.harness}</code><small>{role.modelPolicy}</small><small>{role.workspacePolicy} · {role.resourceAccess}</small><small>{role.dockerSocketAccess ? "Docker socket: sole holder" : "Docker socket: denied"} · avatar: {role.petPolicy}</small></div>
            <footer>{role.recommendedSkills.map((skill) => <span key={skill}>{skill}</span>)}</footer>
          </article>)}
        </div>
      </section>

      <section className="mailroom-layout">
        <form className="panel compose-card" onSubmit={send}>
          <div className="panel-heading compact"><div><span className="eyebrow">CEO-APPROVED MAIL</span><h2>Coordinate an employee</h2></div></div>
          <div className="compose-fields">
            <label>From
              <select value={senderEmployeeId} onChange={(event) => {
                const nextSender = event.target.value;
                updateDraft(() => {
                  setSenderEmployeeId(nextSender);
                  if (recipientEmployeeId === nextSender) setRecipientEmployeeId(mailroom.employees.find((employee) => employee.id !== nextSender)?.id ?? "");
                });
              }} required disabled={!senders.length}>
                {senders.map((employee) => <option value={employee.id} key={employee.id}>{employee.name} · {employee.emailAddress}</option>)}
              </select>
            </label>
            <label>To
              <select value={recipientEmployeeId} onChange={(event) => updateDraft(() => setRecipientEmployeeId(event.target.value))} required disabled={!recipients.length}>
                {recipients.length ? recipients.map((employee) => <option value={employee.id} key={employee.id}>{employee.name} · {employee.emailAddress}</option>) : <option value="">Onboard another employee first</option>}
              </select>
            </label>
            <label>Subject<input value={subject} onChange={(event) => updateDraft(() => setSubject(event.target.value))} maxLength={160} placeholder="Clear outcome or decision" required /></label>
            <label>Brief<textarea value={body} onChange={(event) => updateDraft(() => setBody(event.target.value))} rows={8} maxLength={12000} placeholder="Context, requested outcome, constraints, and when to escalate..." required /></label>
            <button className="primary-action" disabled={busy || !senderEmployeeId || !recipientEmployeeId || subject.trim().length < 2 || body.trim().length < 2}>{busy ? "Recording..." : "Queue through Stalwart"}</button>
            <small className="truth-note">Queued means recorded in D1. Sent appears only after the local bridge reports that Stalwart accepted it.</small>
            <small className="truth-note">{dorothy?.name ?? "The Secretary"} is read-only and is intentionally excluded from senders.</small>
          </div>
        </form>

        <section className="panel outbox-card">
          <div className="panel-heading compact"><div><span className="eyebrow">MAIL OUTBOX</span><h2>Delivery evidence</h2></div><span className="mail-count">{mailroom.messages.length}</span></div>
          <div className="mail-list">
            {mailroom.messages.length ? mailroom.messages.map((message) => <article key={message.id}>
              <header><div><b>{message.subject}</b><span>{message.senderName} → {message.recipientName}</span></div><strong className={`mail-${message.status}`}>{message.status}</strong></header>
              <p>{message.body}</p>
              <footer><time>{new Date(message.createdAt).toLocaleString()}</time><code>{message.transport}</code></footer>
              {message.lastError ? <small role="alert">{message.lastError}</small> : null}
            </article>) : <p className="empty-mail">No messages yet. HRM and Project Managers can coordinate after mailboxes are ready.</p>}
          </div>
        </section>
      </section>
    </main>
  );
}
