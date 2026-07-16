// FILENAME: app/extensions/ModelEditor/components/ExpressionEditorModal.tsx
// PURPOSE: A Monaco-based editor modal for a measure-syntax expression (the
//          same highlighting + function/table/column/measure completion + hover
//          + signature help the measure editor uses). Generic (title + initial
//          value + model overview for context) so it can edit any measure-syntax
//          field — e.g. a column's lookup-resolution expression.

import React, { useEffect, useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { biModelFunctionCatalog } from "@api";
import type { ModelOverview } from "@api";
import { Modal, styles } from "./editorShared";
import {
  MEASURE_LANGUAGE_ID,
  registerMeasureLanguage,
  setMeasureLanguageContext,
} from "../lib/measureLanguage";

// Chain the worker handler so this editor never clobbers another Monaco setup
// in the same window (mirrors sections/ExpressionWorkspace / SqlEditorModal).
const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(id: string, label: string) {
    return prevGetWorker ? prevGetWorker(id, label) : new editorWorker();
  },
};
loader.config({ monaco });

export function ExpressionEditorModal({
  title,
  initialValue,
  overview,
  hint,
  onClose,
  onSave,
}: {
  title: string;
  initialValue: string;
  /** The model — feeds function/table/column/measure completion + hover. */
  overview: ModelOverview;
  hint?: string;
  onClose: () => void;
  onSave: (value: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState(initialValue);

  const handleMount: OnMount = (editor) => {
    registerMeasureLanguage();
    editor.focus();
  };

  useEffect(() => {
    let cancelled = false;
    const context = {
      tables: overview.tables.map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => c.name),
      })),
      measures: overview.measures.map((m) => m.name),
    };
    biModelFunctionCatalog()
      .then((cat) => {
        if (!cancelled) setMeasureLanguageContext(cat, context);
      })
      .catch(() => {
        if (!cancelled) setMeasureLanguageContext([], context);
      });
    return () => {
      cancelled = true;
    };
  }, [overview]);

  return (
    <Modal
      title={title}
      width={720}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} onClick={() => onSave(value)}>
            Save
          </button>
        </>
      }
    >
      <div style={{ border: "1px solid #ccc", borderRadius: 4, overflow: "hidden" }}>
        <Editor
          height="300px"
          language={MEASURE_LANGUAGE_ID}
          value={value}
          onMount={handleMount}
          onChange={(v) => setValue(v ?? "")}
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
