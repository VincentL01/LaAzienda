"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { EmployeeSprite } from "./EmployeeSprite";
import {
  animationStates,
  employeeStatuses,
  spriteTracks,
  statusLabels,
  type AnimationMapping,
  type AnimationState,
  type CompanyState,
} from "@/lib/company";

export function AnimationStudio() {
  const [mappings, setMappings] = useState<AnimationMapping[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/company", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as CompanyState & { error?: string };
        if (!response.ok) throw new Error(data.error || "Could not load animation rules");
        return data;
      })
      .then((data) => { if (!cancelled) setMappings(data.mappings); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, []);

  function change(status: string, patch: Partial<AnimationMapping>) {
    setSaved(false);
    setMappings((current) => current.map((mapping) => mapping.employeeStatus === status ? { ...mapping, ...patch } : mapping));
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/company", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "saveMappings", mappings }),
      });
      const data = await response.json() as CompanyState & { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not save animation rules");
      setMappings(data.mappings);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (!mappings.length) return error
    ? <main className="loading-room"><div><b>Animation controls are locked or unavailable.</b><p role="alert">{error}</p><Link href="/training">Unlock CEO controls in the Training Room</Link></div></main>
    : <main className="loading-room"><span className="pixel-loader" /> Loading animation studio…</main>;

  return (
    <main className="studio-shell">
      <section className="studio-hero">
        <div><span className="eyebrow">CHARACTER SYSTEM</span><h1>Make every status<br />feel alive.</h1></div>
        <div className="studio-intro"><p>Dorothy’s Codex Pet pack contains nine action rows. Map those actions to the company states your employees actually use.</p><span>8 columns × 11 rows · Codex Pet v2</span></div>
      </section>
      {error && <p className="studio-error" role="alert">{error}</p>}

      <section className="mapping-board" aria-label="Employee status animation mappings">
        <div className="mapping-head"><span>Employee status</span><span>Live preview</span><span>Animation track</span><span>Frame speed</span></div>
        {employeeStatuses.map((status) => {
          const mapping = mappings.find((item) => item.employeeStatus === status);
          if (!mapping) return null;
          return <article className="mapping-row" key={status}>
            <div className="mapping-status"><i className={`status-dot status-${status}`} /><div><b>{statusLabels[status]}</b><span>{status}</span></div></div>
            <div className="mapping-preview"><EmployeeSprite animation={mapping.animationState} speedMs={mapping.speedMs} size="small" /></div>
            <label><span className="sr-only">Animation for {statusLabels[status]}</span><select value={mapping.animationState} onChange={(event) => change(status, { animationState: event.target.value as AnimationState })}>
              {animationStates.map((animation) => <option key={animation} value={animation}>{spriteTracks[animation].label}</option>)}
            </select></label>
            <label className="speed-control"><span className="sr-only">Frame speed for {statusLabels[status]}</span><input type="range" min="80" max="600" step="10" value={mapping.speedMs} onChange={(event) => change(status, { speedMs: Number(event.target.value) })} /><output>{mapping.speedMs} ms</output></label>
          </article>;
        })}
      </section>

      <section className="studio-footer">
        <div><b>Tip</b><p>Keep working fast and waiting slow; the contrast makes the office readable at a glance.</p></div>
        <button onClick={save} disabled={busy || !mappings.length}>{busy ? "Saving…" : saved ? "Saved ✓" : "Save animation rules"}</button>
      </section>
    </main>
  );
}
