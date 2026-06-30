//! FILENAME: app/extensions/Animation/components/TimelinePanel.tsx
// PURPOSE: The Animation timeline panel — configure a clock-cell driver and drive
//          playback (play/pause/stop/step, scrubber, fps, loop). A pure view over
//          the playbackEngine (subscribes to its ClockState; holds no clock state).
import React, { useCallback, useEffect, useState } from "react";
import type { PanelSectionProps } from "@api/uiTypes";
import { getActiveSheet } from "@api/lib";
import { playbackEngine, type EngineState } from "../lib/animationEngine";
import { PlayIcon, PauseIcon, StopIcon, StepBackIcon, StepFwdIcon } from "./icons";

/** Parse an A1-style address ("B1", "$AA$10") to 0-based row/col. */
function parseA1(addr: string): { row: number; col: number } | null {
  const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})\s*$/.exec(addr);
  if (!m) return null;
  const letters = m[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
  col -= 1;
  const row = parseInt(m[2], 10) - 1;
  if (row < 0 || col < 0) return null;
  return { row, col };
}

const btn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 28,
  height: 26,
  padding: "0 6px",
  border: "1px solid var(--border-color, #d0d0d0)",
  borderRadius: 4,
  background: "var(--button-bg, #fff)",
  cursor: "pointer",
};
const field: React.CSSProperties = {
  width: "100%",
  height: 24,
  boxSizing: "border-box",
  padding: "0 6px",
  border: "1px solid var(--border-color, #d0d0d0)",
  borderRadius: 4,
};
const label: React.CSSProperties = { fontSize: 11, opacity: 0.75, marginBottom: 2 };

export function TimelinePanel({ placement }: PanelSectionProps): React.ReactElement {
  const [state, setState] = useState<EngineState>(() => playbackEngine.getState());
  useEffect(() => playbackEngine.subscribe(setState), []);

  const [cellRef, setCellRef] = useState("B1");
  const [fromStr, setFromStr] = useState("0");
  const [toStr, setToStr] = useState("100");
  const [stepStr, setStepStr] = useState("1");
  const [formError, setFormError] = useState<string | null>(null);

  const hasDriver = state.frameCount > 0;
  const isPlaying = state.status === "playing";

  const handleSetDriver = useCallback(async () => {
    const parsed = parseA1(cellRef);
    if (!parsed) {
      setFormError("Enter a driver cell like B1");
      return;
    }
    const from = Number(fromStr);
    const to = Number(toStr);
    const step = Number(stepStr);
    if (![from, to, step].every(Number.isFinite) || step === 0) {
      setFormError("From / To / Step must be numbers and Step ≠ 0");
      return;
    }
    setFormError(null);
    const sheetIndex = await getActiveSheet();
    await playbackEngine.setClockCellDriver({
      sheetIndex,
      row: parsed.row,
      col: parsed.col,
      from,
      to,
      step,
    });
  }, [cellRef, fromStr, toStr, stepStr]);

  const horizontal = placement === "ribbon";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        gap: 10,
        padding: 8,
        fontSize: 12,
        alignItems: horizontal ? "center" : "stretch",
      }}
    >
      {/* Driver configuration */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 180 }}>
        <div>
          <div style={label}>Driver cell</div>
          <input style={field} value={cellRef} onChange={(e) => setCellRef(e.target.value)} placeholder="B1" />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <div style={{ flex: 1 }}>
            <div style={label}>From</div>
            <input style={field} value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={label}>To</div>
            <input style={field} value={toStr} onChange={(e) => setToStr(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={label}>Step</div>
            <input style={field} value={stepStr} onChange={(e) => setStepStr(e.target.value)} />
          </div>
        </div>
        <button style={{ ...btn, width: "100%" }} onClick={() => void handleSetDriver()}>
          Set driver
        </button>
        {formError && <div style={{ color: "var(--error-color, #c0392b)", fontSize: 11 }}>{formError}</div>}
      </div>

      {/* Transport */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 200 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button style={btn} title="Step back" disabled={!hasDriver} onClick={() => void playbackEngine.step(-1)}>
            <StepBackIcon />
          </button>
          <button
            style={btn}
            title={isPlaying ? "Pause" : "Play"}
            disabled={!hasDriver}
            onClick={() => (isPlaying ? playbackEngine.pause() : playbackEngine.play())}
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button style={btn} title="Stop (reset)" disabled={!hasDriver} onClick={() => void playbackEngine.stop()}>
            <StopIcon />
          </button>
          <button style={btn} title="Step forward" disabled={!hasDriver} onClick={() => void playbackEngine.step(1)}>
            <StepFwdIcon />
          </button>
          <div style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", opacity: 0.85 }}>
            {hasDriver ? `${state.frame + 1} / ${state.frameCount}` : "no driver"}
          </div>
        </div>

        <input
          type="range"
          min={state.rangeStart}
          max={state.rangeEnd}
          value={state.frame}
          step={1}
          disabled={!hasDriver}
          onChange={(e) => void playbackEngine.seek(Number(e.target.value))}
          style={{ width: "100%" }}
        />

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontVariantNumeric: "tabular-nums" }}>
            value: <strong>{state.frameLabel ?? "—"}</strong>
          </div>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            fps
            <input
              type="number"
              min={1}
              max={120}
              value={state.fps}
              onChange={(e) => playbackEngine.setFps(Number(e.target.value))}
              style={{ ...field, width: 56 }}
            />
          </label>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={state.loop} onChange={(e) => playbackEngine.setLoop(e.target.checked)} />
            loop
          </label>
        </div>
      </div>
    </div>
  );
}
