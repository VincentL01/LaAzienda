"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  runtimeStatusLabels,
  statusLabels,
  type CharacterPack,
  type DesiredRuntimeStatus,
  type WorkforceState,
} from "@/lib/company";
import { EmployeeSprite } from "./EmployeeSprite";

export function EmployeeOnboarding() {
  const [workforce, setWorkforce] = useState<WorkforceState | null>(null);
  const [name, setName] = useState("");
  const [roleProfileId, setRoleProfileId] = useState("");
  const [role, setRole] = useState("");
  const [department, setDepartment] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [petId, setPetId] = useState("");
  const [characterFile, setCharacterFile] = useState<File | null>(null);
  const [characterNotice, setCharacterNotice] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const characterInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/employees", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as WorkforceState & { error?: string };
        if (!response.ok) throw new Error(data.error || "Could not load employees");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setWorkforce(data);
        const defaultRole = data.roles.find((profile) => profile.id === "software-engineer") ?? data.roles[0];
        if (defaultRole) {
          setRoleProfileId(defaultRole.id);
          setRole(defaultRole.title);
          setDepartment(defaultRole.department);
          setSystemPrompt(defaultRole.systemPrompt);
          setPetId(defaultRole.fixedPetId ?? data.characters.find((character) => character.cacheStatus === "cached" && !["aurelia-executive-04", "crimson-executive", "solaire"].includes(character.id))?.id ?? "");
          const recommended = new Set(defaultRole.recommendedSkills);
          setSkillIds(data.skills.filter((skill) => skill.cacheStatus === "cached" && recommended.has(skill.packageRef.split("@").at(-1) ?? skill.packageRef)).map((skill) => skill.id));
        }
      })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, []);

  async function act(payload: Record<string, unknown>, key: string) {
    setBusy(key);
    setError("");
    try {
      const response = await fetch("/api/employees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json() as WorkforceState & { error?: string };
      if (!response.ok) throw new Error(data.error || "The workforce action failed");
      setWorkforce(data);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function onboard(event: FormEvent) {
    event.preventDefault();
    const saved = await act({ action: "onboard", name, roleProfileId, role, department, systemPrompt, petId, skillIds }, "onboard");
    if (saved) {
      setName("");
      setSkillIds([]);
    }
  }

  async function importCharacter() {
    if (!characterFile) return;
    setBusy("character-import");
    setError("");
    setCharacterNotice("");
    setUploadProgress(0);
    try {
      const chunkSize = 384 * 1024;
      const totalChunks = Math.ceil(characterFile.size / chunkSize);
      if (characterFile.size > 12 * 1024 * 1024) throw new Error("Character ZIP files must be smaller than 12 MB");
      const sessionId = crypto.randomUUID();
      let uploaded = 0;
      for (let start = 0; start < totalChunks; start += 4) {
        const batch = Array.from({ length: Math.min(4, totalChunks - start) }, (_, offset) => start + offset);
        await Promise.all(batch.map(async (index) => {
          const chunk = characterFile.slice(index * chunkSize, Math.min(characterFile.size, (index + 1) * chunkSize));
          const chunkResponse = await fetch(`/api/characters/import?phase=chunk&session=${sessionId}&index=${index}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: chunk,
          });
          if (!chunkResponse.ok) {
            const result = await chunkResponse.json() as { error?: string };
            throw new Error(result.error || `Upload chunk ${index + 1} failed`);
          }
          uploaded += 1;
          setUploadProgress(Math.round((uploaded / totalChunks) * 90));
        }));
      }
      const response = await fetch("/api/characters/import?phase=complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, totalChunks, expectedSize: characterFile.size, originalFilename: characterFile.name }),
      });
      const data = await response.json() as WorkforceState & { importedCharacterId?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "The character could not be imported");
      setUploadProgress(100);
      setWorkforce(data);
      const activeRole = data.roles.find((profile) => profile.id === roleProfileId);
      if (data.importedCharacterId && activeRole?.petPolicy === "random") setPetId(data.importedCharacterId);
      setCharacterNotice(activeRole?.petPolicy === "random"
        ? `${characterFile.name} is ready in the Expert character pool; HRM will choose randomly on hire.`
        : `${characterFile.name} is cached for a future role. This role keeps its fixed company character.`);
      setCharacterFile(null);
      if (characterInput.current) characterInput.current.value = "";
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Character import failed");
    } finally {
      setBusy("");
    }
  }

  const charactersById = useMemo(
    () => new Map((workforce?.characters ?? []).map((character) => [character.id, character])),
    [workforce?.characters],
  );
  const cachedSkills = workforce?.skills.filter((skill) => skill.cacheStatus === "cached") ?? [];
  const cachedCharacters = workforce?.characters.filter((character) => character.cacheStatus === "cached") ?? [];
  const selectedCharacter = charactersById.get(petId);
  const selectedRole = workforce?.roles.find((profile) => profile.id === roleProfileId);
  const contractorName = selectedRole?.employmentType === "contractor";
  const staffedSingletonIds = new Set(
    workforce?.employees.filter((employee) => workforce.roles.find((profile) => profile.id === employee.roleProfileId)?.isSingleton).map((employee) => employee.roleProfileId) ?? [],
  );

  function chooseRole(nextRoleId: string) {
    const nextRole = workforce?.roles.find((profile) => profile.id === nextRoleId);
    if (!nextRole) return;
    setRoleProfileId(nextRole.id);
    setRole(nextRole.title);
    setDepartment(nextRole.department);
    setSystemPrompt(nextRole.systemPrompt);
    setName(nextRole.employmentType === "contractor" ? "" : name);
    const randomCharacter = cachedCharacters.find((character) => !["aurelia-executive-04", "crimson-executive", "solaire"].includes(character.id));
    setPetId(nextRole.fixedPetId ?? randomCharacter?.id ?? "");
    const recommended = new Set(nextRole.recommendedSkills);
    setSkillIds(cachedSkills.filter((skill) => recommended.has(skill.packageRef.split("@").at(-1) ?? skill.packageRef)).map((skill) => skill.id));
  }

  if (!workforce) return error
    ? <main className="loading-room"><div><b>Personnel files are locked or unavailable.</b><p role="alert">{error}</p><Link href="/training">Unlock CEO controls in the Training Room</Link></div></main>
    : <main className="loading-room"><span className="pixel-loader" /> Opening personnel files...</main>;

  return (
    <main className="people-shell">
      <section className="people-hero">
        <div>
          <span className="eyebrow">PEOPLE OPERATIONS</span>
          <h1>Hire a brain.<br />Give it a craft.</h1>
          <p>Each employee gets a durable profile, a private container specification, and only the skills already approved by the Training Center.</p>
        </div>
        <div className="runtime-rule">
          <span>TRUST BOUNDARY</span>
          <b>Aurelia alone holds the Docker socket</b>
          <p>Every other employee requests a runtime. HRM provisions and reports the real container state.</p>
        </div>
      </section>

      {error ? <p className="studio-error" role="alert">{error}</p> : null}

      <section className="people-layout">
        <form className="onboard-card panel" onSubmit={onboard}>
          <div className="panel-heading compact"><div><span className="eyebrow">ONBOARDING DESK</span><h2>New employee</h2></div></div>
          <div className="onboard-fields">
            <label>Company role
              <select value={roleProfileId} onChange={(event) => chooseRole(event.target.value)} required>
                {workforce.roles.map((profile) => <option value={profile.id} key={profile.id} disabled={profile.isSingleton && staffedSingletonIds.has(profile.id)}>{profile.title} / {profile.department}{profile.isSingleton && staffedSingletonIds.has(profile.id) ? " (staffed)" : ""}</option>)}
              </select>
            </label>
            {selectedRole ? <div className="role-brief" aria-live="polite">
              <b>{selectedRole.mission}</b>
              <span>{selectedRole.harness}</span>
              <span>{selectedRole.modelPolicy}</span>
              <span>{selectedRole.employmentType} / {selectedRole.workspacePolicy} workspace / {selectedRole.resourceAccess}</span>
              <span>{selectedRole.dockerSocketAccess ? "Docker socket authority" : "No Docker socket"} / {selectedRole.handoffRequired ? "Handoff required" : "Standard closeout"}</span>
              <span>{selectedRole.petPolicy === "fixed" ? `Fixed character: ${selectedRole.fixedPetId}` : "Character selected randomly from the open roster"}</span>
              <small>Suggested training: {selectedRole.recommendedSkills.join(", ")}</small>
            </div> : null}
            <div className="field-pair">
              <label>Name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder={contractorName ? "Assigned a Medieval name by HRM" : "e.g. Linus"} required={!contractorName} disabled={contractorName} /></label>
              <label>Job title<input value={role} onChange={(event) => setRole(event.target.value)} maxLength={80} required /></label>
            </div>
            <label>Department<input value={department} onChange={(event) => setDepartment(event.target.value)} maxLength={80} /></label>
            <label>System prompt<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={7} maxLength={8000} required /></label>
            <fieldset className="character-picker">
              <legend>Character</legend>
              <div className="character-select-row">
                <div className="character-preview"><EmployeeSprite animation="idle" size="small" spritesheetPath={selectedCharacter?.spritesheetPath} label={selectedCharacter ? `${selectedCharacter.displayName} preview` : "Character preview"} /></div>
                <select aria-label="Employee character" value={petId} onChange={(event) => { setPetId(event.target.value); setCharacterNotice(""); }} disabled={Boolean(selectedRole)}>
                  {cachedCharacters.map((character) => <option value={character.id} key={character.id}>{character.displayName}</option>)}
                </select>
              </div>
              <small className="character-policy">{selectedRole?.petPolicy === "fixed" ? "This role has a fixed company character." : "HRM chooses randomly from non-reserved character packs when the employee is created."}</small>
              <div className="zip-import">
                <div><b>Import a Codex Pet ZIP</b><small>pet.json + original spritesheet, up to 12 MB</small></div>
                <label className="file-button">
                  <span>{characterFile ? "Change ZIP" : "Choose ZIP"}</span>
                  <input ref={characterInput} className="sr-only" type="file" accept=".zip,application/zip" onChange={(event) => { setCharacterFile(event.target.files?.[0] ?? null); setCharacterNotice(""); setError(""); }} />
                </label>
                <button type="button" className="secondary-action" disabled={!characterFile || busy === "character-import"} onClick={importCharacter}>{busy === "character-import" ? "Importing..." : "Import"}</button>
                {characterFile ? <code>{characterFile.name}{busy === "character-import" ? ` · ${uploadProgress}%` : ""}</code> : null}
                {characterNotice ? <p className="import-success" role="status">{characterNotice}</p> : null}
              </div>
            </fieldset>
            <fieldset className="skill-picker">
              <legend>Desired training</legend>
              {cachedSkills.length ? cachedSkills.map((skill) => <label key={skill.id} aria-label={`Assign ${skill.name}`}>
                <input type="checkbox" checked={skillIds.includes(skill.id)} onChange={(event) => setSkillIds((current) => event.target.checked ? [...current, skill.id] : current.filter((id) => id !== skill.id))} />
                <span><b>{skill.name}</b><small>{skill.packageRef}</small></span>
              </label>) : <p>No cached skills yet. Import one in the Training Center first.</p>}
            </fieldset>
            <button className="primary-action" disabled={Boolean(busy) || (!contractorName && !name.trim()) || !role.trim() || !roleProfileId}>{busy === "onboard" ? "Creating file..." : contractorName ? "Commission contractor" : "Onboard employee"}</button>
          </div>
        </form>

        <section className="roster-panel">
          <div className="section-heading"><div><span className="eyebrow">COMPANY ROSTER</span><h2>{workforce.employees.length} {workforce.employees.length === 1 ? "employee" : "employees"}</h2></div></div>
          <div className="employee-grid">
            {workforce.employees.map((employee) => {
              const character = charactersById.get(employee.petId) as CharacterPack | undefined;
              const desired: DesiredRuntimeStatus = employee.desiredRuntimeStatus === "running" ? "stopped" : "running";
              return <article className="employee-card" key={employee.id}>
                <header>
                  <div className="avatar-tile"><EmployeeSprite animation={employee.status === "working" ? "running" : employee.status === "failed" ? "failed" : "idle"} size="small" spritesheetPath={character?.spritesheetPath} label={`${employee.name} character`} /></div>
                  <div><span className={`status-dot status-${employee.status}`} /><b>{employee.name}</b><small>{employee.role} / {employee.department}</small></div>
                </header>
                <div className="runtime-line"><span>Agent</span><b>{statusLabels[employee.status]}</b><span>Docker</span><b>{runtimeStatusLabels[employee.runtimeStatus]}</b></div>
                <div className="employee-policy-line"><span>{employee.employmentType}</span><span>{employee.workspacePolicy}</span><span>{employee.resourceAccess}</span>{employee.dockerSocketAccess ? <strong>SOCKET HOLDER</strong> : null}{employee.handoffRequired ? <strong>HANDOFF</strong> : null}</div>
                <div className="mailbox-line"><code>{employee.emailAddress}</code><span className={`mailbox-${employee.mailboxStatus}`}>{employee.mailboxStatus}</span></div>
                <div className="skill-chips">
                  {employee.skills.length ? employee.skills.map((skill) => <span key={skill.id}>Verified · {skill.name}</span>) : <i>No verified skills</i>}
                  {employee.desiredSkills.filter((desiredSkill) => !employee.skills.some((verifiedSkill) => verifiedSkill.id === desiredSkill.id))
                    .map((skill) => <span key={`pending:${skill.id}`}>Pending · {skill.name}</span>)}
                </div>
                <details><summary>Employee brain</summary><p>{employee.systemPrompt}</p><code>{employee.containerName}</code></details>
                <button className={desired === "running" ? "primary-action" : "secondary-action"} disabled={busy === employee.id} onClick={() => act({ action: "requestRuntime", employeeId: employee.id, desired }, employee.id)}>
                  {busy === employee.id ? "Recording request..." : employee.dockerSocketAccess && desired === "running" ? "Bootstrap HR Manager" : desired === "running" ? "Request HRM start" : "Request HRM stop"}
                </button>
              </article>;
            })}
          </div>
        </section>
      </section>
    </main>
  );
}
