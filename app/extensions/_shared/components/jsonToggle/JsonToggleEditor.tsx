//! FILENAME: app/extensions/JsonView/components/JsonToggleEditor.tsx
// PURPOSE: The editor panel shown when a GUI/JSON toggle is active.
// CONTEXT: Phase C — renders Monaco editor + Apply/Revert bar, used inside
//          existing config panels when JSON mode is toggled on.

import React from "react";
import { MonacoJsonEditor } from "./MonacoJsonEditor";

const s = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    backgroundColor: "#1e1e1e",
  },
  editor: {
    flex: 1,
    minHeight: 0,
  },
  actionBar: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "6px 8px",
    borderTop: "1px solid #333",
    flexShrink: 0,
  },
  applyBtn: {
    backgroundColor: "#0e639c",
    color: "#ffffff",
    border: "none",
    borderRadius: "3px",
    padding: "4px 10px",
    fontSize: "12px",
    cursor: "pointer",
    fontFamily: "'Segoe UI', sans-serif",
  },
  revertBtn: {
    backgroundColor: "#3c3c3c",
    color: "#cccccc",
    border: "1px solid #555",
    borderRadius: "3px",
    padding: "4px 10px",
    fontSize: "12px",
    cursor: "pointer",
    fontFamily: "'Segoe UI', sans-serif",
  },
  disabled: {
    opacity: 0.5,
    cursor: "default" as const,
  },
  errorBar: {
    padding: "3px 8px",
    fontSize: "11px",
    color: "#f48771",
    borderTop: "1px solid #333",
    flexShrink: 0,
  },
};

interface JsonToggleEditorProps {
  json: string;
  onChange: (value: string) => void;
  onApply: () => void;
  onRevert: () => void;
  dirty: boolean;
  error: string | null;
  loading: boolean;
}

export function JsonToggleEditor({
  json,
  onChange,
  onApply,
  onRevert,
  dirty,
  error,
  loading,
}: JsonToggleEditorProps): React.ReactElement {
  const canApply = dirty && error === null && !loading;

  return (
    <div style={s.container}>
      <div style={s.editor}>
        <MonacoJsonEditor value={json} onChange={onChange} readOnly={loading} />
      </div>
      <div style={s.actionBar}>
        <button
          style={{ ...s.applyBtn, ...(canApply ? {} : s.disabled) }}
          onClick={onApply}
          disabled={!canApply}
        >
          Apply
        </button>
        <button
          style={{ ...s.revertBtn, ...(dirty ? {} : s.disabled) }}
          onClick={onRevert}
          disabled={!dirty}
        >
          Revert
        </button>
      </div>
      {error ? <div style={s.errorBar}>{error}</div> : null}
    </div>
  );
}
