//! FILENAME: app/extensions/MacroRecorder/components/RecordingIndicator.tsx
// PURPOSE: The always-visible "you are recording" status-bar item.
// CONTEXT: A recorder that can be left running without the user noticing is a
//          trap — every subsequent edit silently joins the macro. The indicator
//          is therefore unmissable (a pulsing red dot), states the action count
//          so the user can see capture happening, and carries Stop right next
//          to it so stopping never requires hunting through a menu.

import React, { useSyncExternalStore } from "react";
import {
  getRecorderSnapshot,
  pauseRecording,
  resumeRecording,
  subscribeToRecorder,
} from "../lib/actionRecorder";
import { abandonRecording, finishRecording } from "../lib/flow";

const PULSE_KEYFRAMES_ID = "macro-recorder-pulse";

/** Inject the pulse keyframes once (inline styles cannot express @keyframes). */
function usePulseKeyframes(): void {
  React.useEffect(() => {
    if (document.getElementById(PULSE_KEYFRAMES_ID)) return;
    const el = document.createElement("style");
    el.id = PULSE_KEYFRAMES_ID;
    el.textContent =
      "@keyframes macroRecorderPulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } }";
    document.head.appendChild(el);
  }, []);
}

const wrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 8px",
  fontSize: 12,
};

const dot: React.CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: "50%",
  background: "#e04a3f",
  flexShrink: 0,
};

const link: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: 12,
  padding: "0 2px",
  textDecoration: "underline",
};

export function RecordingIndicator(): React.ReactElement | null {
  usePulseKeyframes();
  const snap = useSyncExternalStore(
    subscribeToRecorder,
    getRecorderSnapshot,
    getRecorderSnapshot,
  );

  if (snap.status === "idle") return null;

  const recording = snap.status === "recording";
  const dotStyle: React.CSSProperties = recording
    ? { ...dot, animation: "macroRecorderPulse 1.2s ease-in-out infinite" }
    : { ...dot, background: "var(--text-secondary)" };

  return (
    <div style={wrap} title={`Macro "${snap.name}"`} data-macro-recorder-indicator="">
      <span style={dotStyle} aria-hidden="true" />
      <span>
        {recording ? "Recording" : "Paused"} · {snap.actionCount}{" "}
        {snap.actionCount === 1 ? "action" : "actions"}
      </span>
      <button
        type="button"
        style={link}
        onClick={() => (recording ? pauseRecording() : resumeRecording())}
      >
        {recording ? "Pause" : "Resume"}
      </button>
      <button type="button" style={link} onClick={() => finishRecording()}>
        Stop
      </button>
      <button
        type="button"
        style={link}
        onClick={() => {
          if (
            window.confirm("Discard this recording? The actions already taken stay in the workbook.")
          ) {
            abandonRecording();
          }
        }}
      >
        Discard
      </button>
    </div>
  );
}
