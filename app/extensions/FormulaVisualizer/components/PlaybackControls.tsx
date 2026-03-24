//! FILENAME: app/extensions/FormulaVisualizer/components/PlaybackControls.tsx
// PURPOSE: Transport controls for formula evaluation playback.

import React from "react";
import type { PlaybackControls as PlaybackControlsType } from "../hooks/usePlayback";
import { SPEED_LEVELS } from "../constants";

const v = (name: string) => `var(${name})`;

interface PlaybackControlsProps {
  controls: PlaybackControlsType;
  totalSteps: number;
}

const btnBase: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  borderRadius: 4,
  cursor: "pointer",
  border: `1px solid ${v("--border-default")}`,
  background: v("--grid-bg"),
  color: v("--text-primary"),
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  minWidth: 32,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const btnDisabled: React.CSSProperties = {
  opacity: 0.4,
  cursor: "not-allowed",
};

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  background: v("--accent-primary"),
  color: "#ffffff",
  border: `1px solid ${v("--accent-primary")}`,
};

function Btn({
  onClick,
  disabled,
  primary,
  children,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: React.ReactNode;
  title?: string;
}): React.ReactElement {
  const style = {
    ...(primary ? btnPrimary : btnBase),
    ...(disabled ? btnDisabled : {}),
  };
  return (
    <button
      style={style}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export function PlaybackControls({
  controls,
  totalSteps,
}: PlaybackControlsProps): React.ReactElement {
  const { state, play, pause, stepForward, stepBack, reset, jumpToEnd, setSpeed } = controls;
  const { status, currentStep, speedIndex } = state;
  const isPlaying = status === "playing";
  const isComplete = status === "complete";
  const atStart = currentStep < 0;

  const speedLabel = ["0.5x", "0.75x", "1x", "1.5x", "2x"][speedIndex] ?? "1x";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 0",
        flexWrap: "wrap",
      }}
    >
      {/* Transport buttons */}
      <div style={{ display: "flex", gap: 4 }}>
        <Btn onClick={reset} disabled={atStart && !isPlaying} title="Reset (R)">
          {"|\u25C0"}
        </Btn>
        <Btn onClick={stepBack} disabled={atStart} title="Step Back (\u2190)">
          {"\u25C0"}
        </Btn>
        {isPlaying ? (
          <Btn onClick={pause} primary title="Pause (Space)">
            {"| |"}
          </Btn>
        ) : (
          <Btn onClick={play} primary disabled={totalSteps === 0} title="Play (Space)">
            {"\u25B6"}
          </Btn>
        )}
        <Btn onClick={stepForward} disabled={isComplete} title="Step Forward (\u2192)">
          {"\u25B6|"}
        </Btn>
        <Btn onClick={jumpToEnd} disabled={isComplete} title="Jump to End">
          {"\u25B6|"}
        </Btn>
      </div>

      {/* Step counter */}
      <span
        style={{
          fontSize: 12,
          color: v("--text-secondary"),
          minWidth: 80,
          textAlign: "center",
          fontFamily: "Consolas, monospace",
        }}
      >
        {currentStep < 0
          ? `0 / ${totalSteps}`
          : `${currentStep + 1} / ${totalSteps}`}
      </span>

      {/* Speed control */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
        <span style={{ fontSize: 11, color: v("--text-secondary") }}>Speed:</span>
        <input
          type="range"
          min={0}
          max={SPEED_LEVELS.length - 1}
          value={speedIndex}
          onChange={(e) => setSpeed(Number(e.target.value))}
          style={{ width: 80, cursor: "pointer" }}
          title={`${speedLabel} (${SPEED_LEVELS[speedIndex]}ms)`}
        />
        <span style={{ fontSize: 11, color: v("--text-secondary"), minWidth: 28 }}>
          {speedLabel}
        </span>
      </div>
    </div>
  );
}
