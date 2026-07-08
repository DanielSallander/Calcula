// FILENAME: app/extensions/ModelEditor/components/SqlEditorModal.tsx
// PURPOSE: A Monaco-based SQL editor modal (syntax highlighting) for editing a
//          longer SQL snippet — e.g. a refresh strategy's "source query". Kept
//          generic (title + initial value + onSave) so it can be reused for any
//          SQL field in the Model Editor.

import React, { useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { Modal, styles } from "./editorShared";

// Chain the worker handler so this editor never clobbers another Monaco setup
// living in the same window (mirrors MeasureEditorModal).
const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(id: string, label: string) {
    return prevGetWorker ? prevGetWorker(id, label) : new editorWorker();
  },
};
loader.config({ monaco });

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

  const handleMount: OnMount = (editor) => {
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
      <div style={{ border: "1px solid #ccc", borderRadius: 4, overflow: "hidden" }}>
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
