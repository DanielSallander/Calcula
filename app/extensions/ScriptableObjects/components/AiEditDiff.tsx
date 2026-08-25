//! FILENAME: app/extensions/ScriptableObjects/components/AiEditDiff.tsx
// PURPOSE: Show what the AI proposes, side by side with what is there now, and
//          make the author choose.
// CONTEXT: 2026-08-25. Requested directly: "when AI edits a script it does not
//          save it directly but rather we get like a diff window and the user is
//          then prompted to either accept or reject". This is that window.
//
//          It renders for BOTH document kinds, and says something different for
//          each, because the consequence of Accept differs. An object script is
//          applied when the author presses Save. A recorded MACRO auto-persists
//          about a second after the buffer changes — so for a macro, Accept IS
//          effectively the save, and the button says so instead of pretending
//          there is another step in between.

import React from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { AiEditDocumentKind } from "../lib/crossWindowEvents";

interface AiEditDiffProps {
  documentName: string;
  documentKind: AiEditDocumentKind;
  /** What is in the buffer right now. */
  original: string;
  /** What the model proposes to replace it with. */
  proposed: string;
  language: string;
  /** The model's account of what it did. */
  summary: string;
  /** The model looked and concluded nothing needed changing. */
  unchanged: boolean;
  onAccept: () => void;
  onReject: () => void;
}

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 3000,
};

const PANEL: React.CSSProperties = {
  width: "min(1100px, 94vw)",
  height: "min(760px, 90vh)",
  backgroundColor: "#1E1E1E",
  border: "1px solid #454545",
  borderRadius: 4,
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
  overflow: "hidden",
};

export function AiEditDiff(props: AiEditDiffProps): React.ReactElement {
  const { documentKind, original, proposed, unchanged } = props;
  const identical = original === proposed;
  const isMacro = documentKind === "module";

  // Count changed lines cheaply, so the header can say how big this is before
  // the author reads a single line of it.
  const changed = React.useMemo(() => {
    if (identical) return 0;
    const a = original.split("\n");
    const b = proposed.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (
      tail < a.length - head &&
      tail < b.length - head &&
      a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
      tail++;
    }
    return Math.max(a.length - head - tail, b.length - head - tail);
  }, [original, proposed, identical]);

  return (
    <div
      style={OVERLAY}
      data-testid="ai-edit-diff"
      role="dialog"
      aria-modal="true"
      aria-label="Review the AI's proposed change"
    >
      <div style={PANEL}>
        {/* ---- Header ---- */}
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid #333",
            flexShrink: 0,
            backgroundColor: "#252526",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#E8E8E8" }}>
            Review the proposed change &mdash; {props.documentName}
          </div>
          <div style={{ fontSize: 11, color: "#B0B0B0", marginTop: 3, lineHeight: 1.5 }}>
            {identical || unchanged ? (
              <span data-testid="ai-edit-diff-nochange">
                The model read the script and made no change to it.
              </span>
            ) : (
              <span data-testid="ai-edit-diff-scale">
                {changed} line{changed === 1 ? "" : "s"} differ. Nothing has been written to your
                script yet.
              </span>
            )}
          </div>
          {props.summary && (
            <div
              data-testid="ai-edit-diff-summary"
              style={{ fontSize: 11, color: "#9CDCFE", marginTop: 5, lineHeight: 1.5 }}
            >
              {props.summary}
            </div>
          )}
        </div>

        {/* ---- The diff ---- */}
        <div style={{ flex: 1, minHeight: 0 }}>
          <DiffEditor
            original={original}
            modified={proposed}
            language={props.language}
            theme="vs-dark"
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 12,
              renderOverviewRuler: false,
              automaticLayout: true,
            }}
          />
        </div>

        {/* ---- The decision ---- */}
        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px solid #333",
            backgroundColor: "#252526",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, fontSize: 11, color: "#9A9A9A", lineHeight: 1.4 }}>
            {isMacro
              ? "Accepting replaces the macro in the editor and saves it within a second — the current version is then gone."
              : "Accepting replaces the text in the editor. Nothing runs until you press Save."}
          </div>
          <button
            className="ose-btn"
            data-testid="ai-edit-reject"
            onClick={props.onReject}
            title="Discard the proposal. Your script is left exactly as it is."
          >
            Reject
          </button>
          <button
            className="ose-btn primary"
            data-testid="ai-edit-accept"
            onClick={props.onAccept}
            disabled={identical}
            title={
              identical
                ? "The proposal is identical to your script; there is nothing to accept."
                : isMacro
                  ? "Replace the macro with this and save it"
                  : "Replace the text in the editor with this"
            }
          >
            {identical ? "Nothing to accept" : isMacro ? "Accept and save" : "Accept"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AiEditDiff;
