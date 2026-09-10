// FILENAME: app/extensions/ModelEditor/components/SqlEditorModal.tsx
// PURPOSE: A Monaco-based SQL editor modal (syntax highlighting) for editing a
//          longer SQL snippet — e.g. a refresh strategy's "source query". Kept
//          generic (title + initial value + onSave) so it can be reused for any
//          SQL field in the Model Editor.

import React, { useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { enforceLfLineEndings } from "../../_shared/lib/monacoLineEndings";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { Modal, styles } from "./editorShared";
import { ME } from "./theme";
import { applyModelEditorTheme } from "../lib/monacoTheme";

// Chain the worker handler so this editor never clobbers another Monaco setup
// living in the same window (mirrors sections/ExpressionWorkspace).
const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(id: string, label: string) {
    return prevGetWorker ? prevGetWorker(id, label) : new editorWorker();
  },
};
loader.config({ monaco });
// Stored text is LF on every platform. Monaco defaults a model created from
// EMPTY text to the OS ending (CRLF here), and @monaco-editor/react creates the
// model before an async document arrives — see _shared/lib/monacoLineEndings.ts.
enforceLfLineEndings(monaco);

export function SqlEditorModal({
  title,
  initialSql,
  hint,
  onClose,
  onSave,
}: {
  title: string;
  initialSql: string;
  hint?: string;
  onClose: () => void;
  onSave: (sql: string) => void;
}): React.ReactElement {
  const [sql, setSql] = useState(initialSql);

  const handleMount: OnMount = (editor, monaco) => {
    // Every Monaco in this window ran the stock light "vs" theme; once the
    // window follows the skin that is a white editor inside a dark dialog.
    applyModelEditorTheme(monaco);
    editor.focus();
  };

  return (
    <Modal
      title={title}
      width={760}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} onClick={() => onSave(sql)}>
            Save query
          </button>
        </>
      }
    >
      <div style={{ border: `1px solid ${ME.ctlBorder}`, borderRadius: 4, overflow: "hidden" }}>
        <Editor
          height="340px"
          language="sql"
          value={sql}
          onMount={handleMount}
          onChange={(v) => setSql(v ?? "")}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            lineNumbers: "on",
            automaticLayout: true,
          }}
        />
      </div>
      {hint && <div style={{ ...styles.hint, marginTop: 6 }}>{hint}</div>}
    </Modal>
  );
}
