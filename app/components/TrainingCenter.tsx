"use client";

import { FormEvent, useEffect, useState } from "react";
import type { TrainingCenterState } from "@/lib/company";

export function TrainingCenter() {
  const [training, setTraining] = useState<TrainingCenterState | null>(null);
  const [query, setQuery] = useState("");
  const [packageRef, setPackageRef] = useState("");
  const [skillName, setSkillName] = useState("");
  const [petSlug, setPetSlug] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/training", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as TrainingCenterState & { error?: string };
        if (!response.ok) throw new Error(data.error || "Could not open the Training Center");
        return data;
      })
      .then((data) => { if (!cancelled) setTraining(data); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, []);

  async function act(payload: Record<string, unknown>, key: string) {
    setBusy(key);
    setError("");
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
      setError(reason instanceof Error ? reason.message : "Something went wrong");
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

  if (!training) return <main className="loading-room"><span className="pixel-loader" /> Unlocking the Training Center...</main>;

  return (
    <main className="training-shell">
      <section className="training-hero">
        <div><span className="eyebrow">GLOBAL TRAINING CENTER</span><h1>Learn once.<br />Teach the whole company.</h1></div>
        <ol className="training-loop"><li><b>1</b> Find a trusted skill</li><li><b>2</b> Cache its real files once</li><li><b>3</b> Assign copies to employees</li></ol>
      </section>
      {error ? <p className="studio-error" role="alert">{error}</p> : null}

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
            <small>The master accepts only the constrained `npx skills add owner/repository@skill-name` form, then inspects the downloaded SKILL.md before confirming it.</small>
            <button className="primary-action" disabled={busy === "request-skill" || !packageRef.trim()}>{busy === "request-skill" ? "Queuing..." : "Give command to master"}</button>
          </div>
        </form>
        <form className="tool-card panel" onSubmit={requestPet}>
          <div className="panel-heading compact"><div><span className="eyebrow">CHARACTER DEPOT</span><h2>Queue a pet</h2></div></div>
          <div className="tool-body">
            <p>Choose an approved character without changing or recompressing its spritesheet.</p>
            <a href={training.petCatalogUrl} target="_blank" rel="noreferrer">Browse codex-pets.net</a>
            <label>Pet slug<input value={petSlug} onChange={(event) => setPetSlug(event.target.value)} placeholder="character-slug" required /></label>
            <button className="primary-action" disabled={busy === "request-pet" || !petSlug.trim()}>{busy === "request-pet" ? "Queuing..." : "Give command to master"}</button>
          </div>
        </form>
      </section>

      <section className="cache-section">
        <div className="section-heading"><div><span className="eyebrow">APPROVED KNOWLEDGE</span><h2>Skill cache</h2></div><p>Confirmation records that the master ran the local import script and inspected the resulting SKILL.md.</p></div>
        <div className="cache-grid">
          {training.skills.map((skill) => <article className="cache-card" key={skill.id}>
            <div><span className={`cache-badge cache-${skill.cacheStatus}`}>{skill.cacheStatus}</span><h3>{skill.name}</h3><p>{skill.packageRef}</p><small>{skill.description}</small></div>
            <code>{skill.installCommand}</code>
            {skill.cacheStatus !== "cached" ? <button className="secondary-action" disabled={busy === skill.id} onClick={() => act({ action: "confirmSkillCached", skillId: skill.id }, skill.id)}>Confirm local cache</button> : <span className="ready-note">Ready to assign</span>}
          </article>)}
          {!training.skills.length ? <div className="empty-cache">No skills have been requested yet.</div> : null}
        </div>
      </section>

      <section className="cache-section">
        <div className="section-heading"><div><span className="eyebrow">CHARACTER LIBRARY</span><h2>Avatar cache</h2></div><p>Pet packages remain byte-for-byte intact in assets/characters and are copied to public assets for the office renderer.</p></div>
        <div className="cache-grid">
          {training.characters.map((character) => <article className="cache-card" key={character.id}>
            <div><span className={`cache-badge cache-${character.cacheStatus}`}>{character.cacheStatus}</span><h3>{character.displayName}</h3><p>{character.id} / Codex Pet v{character.spriteVersion}</p></div>
            {character.installCommand ? <code>{character.installCommand}</code> : <code>Owner-provided local pack</code>}
            {character.cacheStatus !== "cached" ? <button className="secondary-action" disabled={busy === character.id} onClick={() => act({ action: "confirmCharacterCached", slug: character.id }, character.id)}>Confirm local cache</button> : <span className="ready-note">Ready for onboarding</span>}
          </article>)}
        </div>
      </section>
    </main>
  );
}
