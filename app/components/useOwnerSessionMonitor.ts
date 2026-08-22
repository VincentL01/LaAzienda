"use client";

import { useEffect, useRef } from "react";

interface OwnerSessionMonitorOptions {
  locked: boolean;
  onLocked: () => void;
  onRestored: () => void;
}

export function useOwnerSessionMonitor({ locked, onLocked, onRestored }: OwnerSessionMonitorOptions) {
  const onLockedRef = useRef(onLocked);
  const onRestoredRef = useRef(onRestored);

  useEffect(() => {
    onLockedRef.current = onLocked;
    onRestoredRef.current = onRestored;
  }, [onLocked, onRestored]);

  useEffect(() => {
    let cancelled = false;
    let checking = false;

    async function check() {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch("/api/owner-session", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { authorized?: unknown };
        if (cancelled) return;
        if (data.authorized === false) onLockedRef.current();
        if (data.authorized === true && locked) onRestoredRef.current();
      } catch {
        // A failed health check is not proof that authorization was revoked.
      } finally {
        checking = false;
      }
    }

    const timer = window.setInterval(() => { void check(); }, 15_000);
    const refreshOnFocus = () => { void check(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [locked]);
}
