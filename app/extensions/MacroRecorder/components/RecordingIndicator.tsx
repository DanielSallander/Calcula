//! FILENAME: app/extensions/MacroRecorder/components/RecordingIndicator.tsx
// PURPOSE: The always-visible "you are recording" status-bar item.
// CONTEXT: A recorder that can be left running without the user noticing is a
//          trap — every subsequent edit silently joins the macro. The indicator
//          is therefore unmissable (a pulsing red dot), states the action count
//          so the user can see capture happening, and carries Stop right next
//          to it so stopping never requires hunting through a menu.
//
// EVERY BUTTON HERE GOES THROUGH THE REGISTERED COMMAND, not through the lib
// function behind it. Two reasons, and the second is why it is worth the extra
// hop. (1) There is then exactly ONE implementation of "stop" / "pause" /
// "discard", so the button and the command cannot drift — they had already
// drifted: Discard called `abandonRecording()` while `macroRecorder.cancel`
// called the weaker `cancelRecording()`, which leaves a previous recording's
// result sitting in the flow state. (2) It keeps the commands honest: a command
// whose only callers are a script and a test is the same dead-plumbing shape
// this whole feature was rebuilt to remove. The `macroRecorder.` prefix is in
// the recorder's own ignore list, so driving the recorder is never recorded.

import React, { useSyncExternalStore } from "react";
import { CommandRegistry } from "@api";
import { getRecorderSnapshot, subscribeToRecorder } from "../lib/actionRecorder";
import { COMMANDS } from "../lib/ids";

/** Run a recorder command and surface a failure rather than swallowing it. */
function run(commandId: string): void {
  void CommandRegistry.execute(commandId).catch((err) => {
    console.error(`[MacroRecorder] ${commandId} failed:`, err);
  });
}

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
        onClick={() => run(recording ? COMMANDS.PAUSE : COMMANDS.RESUME)}
      >
        {recording ? "Pause" : "Resume"}
      </button>
      <button type="button" style={link} onClick={() => run(COMMANDS.STOP)}>
        Stop
      </button>
      <button
        type="button"
        style={link}
        onClick={() => {
          // The confirm stays HERE, not in the command: a script calling
          // `macroRecorder.cancel` must not be able to raise a modal.
          if (
            window.confirm(
              "Discard this recording? Nothing is saved — Stop instead if you want to keep it. " +
                "The actions already taken stay in the workbook either way.",
            )
          ) {
            run(COMMANDS.CANCEL);
          }
        }}
      >
        Discard
      </button>
    </div>
  );
}
