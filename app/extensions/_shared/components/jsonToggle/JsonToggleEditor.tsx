//! FILENAME: app/extensions/_shared/components/jsonToggle/JsonToggleEditor.tsx
// PURPOSE: The editor panel shown when a GUI/JSON toggle is active.
// CONTEXT: Renders the Monaco editor + an Apply/Revert bar. Used inside the
//          PivotTable Fields pane, the Slicer Settings dialog and the Chart and
//          Table JSON task panes. The code area stays Monaco's own dark theme
//          (a code editor, like the Spec tab); the chrome around it — action
//          bar, buttons, error line — paints from the skin tokens so it sits in
//          a light task pane without a hardcoded dark strip.

import React from "react";
import { Button, LT } from "@api/layout";
import { MonacoJsonEditor } from "./MonacoJsonEditor";

const s = {
  container: {
    display: "flex",
    flexDirection: "column" as const,
    height: "100%",
    backgroundColor: LT.surface,
  },
  editor: {
    flex: 1,
    minHeight: 0,
  },
  actionBar: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 8px",
    borderTop: `1px solid ${LT.border}`,
    flexShrink: 0,
  },
  errorBar: {
    padding: "4px 8px",
    fontSize: "11px",
    color: LT.dangerFg,
    background: LT.dangerBg,
    borderTop: `1px solid ${LT.border}`,
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
        <Button variant="outlined" onClick={onApply} disabled={!canApply}>
          Apply
        </Button>
        <Button variant="outlined" onClick={onRevert} disabled={!dirty}>
          Revert
        </Button>
      </div>
      {error ? (
        <div style={s.errorBar} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
