//! FILENAME: app/extensions/ScriptableObjects/components/AiEditStrip.tsx
// PURPOSE: Ask the AI to change the open script, and show what it is doing —
//          without ever leaving the editor.
// CONTEXT: 2026-08-25, asked for directly: "I want to make AI much more
//          integrated into the process of creating and editing scripts... without
//          the user having to copy the script and paste it into a chat window".
//          This is the composer for that: type what you want changed, watch it
//          work, get a diff.
//
//          IT SENDS THE TEXT ON SCREEN, NOT THE STORED COPY. The author may have
//          typed since the last save, and editing the stored version would throw
//          that away silently and hand back a diff against the wrong thing.

import React, { useState } from "react";
import { ActivityDot } from "../../_shared/components/ActivityDot";
import type { AiEditState } from "../lib/aiEditClient";

interface AiEditStripProps {
  state: AiEditState;
  /** The document's display name, for the placeholder. */
  documentName: string;
  /** False when the window has no AI route at all (no main window listening). */
  disabled?: boolean;
  onAsk: (instruction: string) => void;
  onStop: () => void;
  onDismissError: () => void;
  onClose: () => void;
}

const BAR: React.CSSProperties = {
  padding: "8px 12px",
  backgroundColor: "#252526",
  borderBottom: "1px solid #333",
  flexShrink: 0,
  fontSize: 11,
  color: "#D4D4D4",
};

const EXAMPLES = [
  "Add a guard so it does nothing when the selection is empty",
  "Handle the case where the cell is not a valid hex colour",
  "Explain nothing, just make it run on the active sheet only",
];

export function AiEditStrip(props: AiEditStripProps): React.ReactElement {
  const { state } = props;
  const [text, setText] = useState("");
  const running = state.phase === "running";

  const submit = (): void => {
    const instruction = text.trim();
    if (!instruction || running) return;
    props.onAsk(instruction);
    setText("");
  };

  // ---- Running: the progress line ----
  if (running) {
    return (
      <div style={BAR} data-testid="ai-edit-progress">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ActivityDot status="running" size={7} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: "#E8E8E8" }}>
              {state.progress || "Working"}
            </div>
            <div
              data-testid="ai-edit-live"
              style={{
                color: "#9A9A9A",
                marginTop: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {state.live || `"${state.instruction}"`}
            </div>
          </div>
          <button className="ose-btn" data-testid="ai-edit-stop" onClick={props.onStop}>
            Stop
          </button>
        </div>
        <div style={{ color: "#7A7A7A", marginTop: 5 }}>
          A local model can take several minutes. You can keep editing other scripts &mdash; the
          result comes back here, and nothing is written until you accept it.
        </div>
      </div>
    );
  }

  // ---- Failed: say why, and how to fix it ----
  if (state.phase === "error") {
    return (
      <div
        style={{ ...BAR, backgroundColor: "#3A2323", borderBottom: "1px solid #6A3A3A", color: "#F48771" }}
        data-testid="ai-edit-error"
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, lineHeight: 1.5 }}>
            <strong>The edit did not happen.</strong> {state.summary}
            <div style={{ color: "#C99", marginTop: 2 }}>Your script was not changed.</div>
          </div>
          <button className="ose-btn" data-testid="ai-edit-dismiss" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // ---- Idle: the composer ----
  return (
    <div style={BAR} data-testid="ai-edit-composer">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <textarea
          data-testid="ai-edit-instruction"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. The instruction is usually
            // one line, and reaching for a button breaks the flow.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") props.onClose();
          }}
          placeholder={`What should change in ${props.documentName}?`}
          rows={2}
          disabled={props.disabled}
          style={{
            flex: 1,
            resize: "vertical",
            backgroundColor: "#1E1E1E",
            color: "#D4D4D4",
            border: "1px solid #3C3C3C",
            borderRadius: 2,
            padding: "5px 7px",
            fontSize: 11,
            fontFamily: "inherit",
            lineHeight: 1.5,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button
            className="ose-btn primary"
            data-testid="ai-edit-ask"
            onClick={submit}
            disabled={props.disabled || text.trim().length === 0}
            title="Send the script on screen and this instruction to the model"
          >
            Ask AI
          </button>
          <button className="ose-btn" data-testid="ai-edit-close" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
      <div style={{ color: "#7A7A7A", marginTop: 5, lineHeight: 1.5 }}>
        The model sees the script <em>as it is on screen</em>, including unsaved edits. You will
        get a diff to accept or reject &mdash; nothing is saved for you. For example:{" "}
        <span style={{ color: "#9A9A9A" }}>&ldquo;{EXAMPLES[0]}&rdquo;</span>
      </div>
    </div>
  );
}

export default AiEditStrip;
