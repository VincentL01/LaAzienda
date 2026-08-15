"use client";

import { useEffect, useState } from "react";
import { spriteTracks, type AnimationState } from "@/lib/company";

interface EmployeeSpriteProps {
  animation: AnimationState;
  speedMs?: number;
  size?: "small" | "medium" | "large";
  label?: string;
  spritesheetPath?: string | null;
}

export function EmployeeSprite({
  animation,
  speedMs = 180,
  size = "medium",
  label = "Animated employee",
  spritesheetPath = "/characters/dorothy-idol/spritesheet.webp",
}: EmployeeSpriteProps) {
  const [frame, setFrame] = useState(0);
  const track = spriteTracks[animation];

  useEffect(() => {
    const timer = window.setInterval(() => setFrame((current) => (current + 1) % track.frames), speedMs);
    return () => window.clearInterval(timer);
  }, [speedMs, track.frames]);

  const visibleFrame = frame % track.frames;

  return (
    <div
      className={`employee-sprite sprite-${size}`}
      role="img"
      aria-label={`${label}: ${track.label}`}
      style={{
        backgroundImage: `url('${spritesheetPath ?? "/characters/dorothy-idol/spritesheet.webp"}')`,
        backgroundPosition: `${(visibleFrame / 7) * 100}% ${(track.row / 10) * 100}%`,
      }}
    />
  );
}
