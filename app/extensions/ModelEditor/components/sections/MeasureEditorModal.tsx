// FILENAME: app/extensions/ModelEditor/components/sections/MeasureEditorModal.tsx
// PURPOSE: Monaco-based modal for ONE model measure (add or edit) inside the
//          Model Editor window. Validates through the engine parser
//          (positioned markers) and installs the edit via
//          bi_model_upsert_measure on save. Ported from the old main-window
//          MeasureEditorDialog.

import React, { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { ModelMeasureInfo, ModelOverview } from "@api";
import { biModelFunctionCatalog, biModelUpsertMeasure, biModelValidateMeasure } from "@api";
import { Field, Modal, styles } from "../editorShared";
import {
  MEASURE_LANGUAGE_ID,
  registerMeasureLanguage,
  setMeasureLanguageContext,
} from "../../lib/measureLanguage";

// Preserve any prior worker handler so this editor never clobbers another
// Monaco setup living in the same window.
const prevGetWorker = self.MonacoEnvironment?.getWorker;
self.MonacoEnvironment = {
  getWorker(id: string, label: string) {
    if (prevGetWorker) {
      return prevGetWorker(id, label);
    }
    return new editorWorker();
  },
};
loader.config({ monaco });

const MARKER_OWNER = "calcula-measure-editor";

/** The engine reports parse positions as UTF-8 BYTE offsets; Monaco's
 * getPositionAt wants UTF-16 code-unit offsets. Diverges on non-ASCII
 * (å/ä/ö in table or measure names would misplace the marker). */
function byteToUtf16Offset(text: string, byteOffset: number): number {
  return new TextDecoder().decode(
    new TextEncoder().encode(text).subarray(0, byteOffset),
  ).length;
}

export function MeasureEditorModal({
  connectionId,
  existing,
  overview,
  onClose,
  onSaved,
}: {
  connectionId: string;
  existing: ModelMeasureInfo | null;
  /** The current model — feeds the editor's function/table/column/measure
   *  autocomplete + hover + signature help. */
  overview: ModelOverview;
  onClose: () => void;
  onSaved: (measures: ModelMeasureInfo[]) => void;
}): React.ReactElement {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [formatString, setFormatString] = useState(existing?.formatString ?? "");
  const [formula, setFormula] = useState(existing?.formula ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    registerMeasureLanguage();
  };

  // Feed the language its live context: the engine function catalog (static)
  // plus this model's tables/columns/measures. Refreshes if the model changes.
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

  const setMarker = useCallback((position: number | null, message: string | null) => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (position === null || message === null) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      return;
    }
    const offset = byteToUtf16Offset(model.getValue(), position);
    const start = model.getPositionAt(offset);
    const end = model.getPositionAt(Math.min(offset + 1, model.getValueLength()));
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
    ]);
  }, []);

  const handleValidate = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const result = await biModelValidateMeasure(
        connectionId,
        name,
        formula,
        existing?.name ?? null,
      );
      if (result.ok) {
        setMarker(null, null);
        setStatus("Formula is valid.");
      } else {
        setMarker(result.position, result.message);
        setError(result.message ?? "Invalid formula");
      }
    } catch (err: unknown) {
      setError(String(err));
    }
  }, [connectionId, name, formula, existing, setMarker]);

  const handleSave = useCallback(async () => {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const measures = await biModelUpsertMeasure({
        connectionId,
        originalName: existing?.name ?? null,
        name,
        formula,
        description: description.trim() || null,
        formatString: formatString.trim() || null,
      });
      // The parent applies the fresh measure list and notifies the main
      // window (which recalcs CUBE) — the grid lives in the other window.
      onSaved(measures);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [connectionId, existing, name, formula, description, formatString, onSaved]);

  return (
    <Modal
      title={existing ? `Edit Measure: ${existing.name}` : "New Measure"}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.btn} onClick={() => void handleValidate()}>
            Validate
          </button>
          <button
            style={styles.primaryBtn}
            onClick={() => void handleSave()}
            disabled={busy || !name.trim() || !formula.trim() || !connectionId}
          >
            {busy ? "Saving…" : "Save Measure"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
        Model measures are part of the connection&apos;s model — they persist in
        this workbook and ship when the model is published as a package.
      </div>
      {existing && !existing.hasSource && (
        <div
          style={{
            fontSize: 12,
            padding: "6px 8px",
            marginBottom: 8,
            backgroundColor: "#fff3cd",
            borderRadius: 4,
          }}
        >
          This formula was reconstructed from the stored model (no original
          text). If you save without changing it, the stored definition is
          kept as-is; edit it only if you intend to redefine the measure.
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Name" flex={2}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Revenue"
          />
        </Field>
        <Field label="Format (optional)" flex={1}>
          <input
            style={styles.input}
            value={formatString}
            onChange={(e) => setFormatString(e.target.value)}
            placeholder="#,##0.00"
          />
        </Field>
      </div>
      <Field label="Description (optional)">
        <input
          style={styles.input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <Field
        label="Formula"
        hint="e.g. SUM(Sales[amount]) or ([Profit] / [Revenue]) * SUM(Sales[qty]) — reference other measures as [Name], columns as Table[column]. Use GVAR for a query-scoped value (evaluated once per query, ignores the row axis, respects slicers) — e.g. GVAR grand = SUM(Sales[amount]) RETURN DIVIDE(SUM(Sales[amount]), grand)."
      >
        <div style={{ border: "1px solid #ccc", borderRadius: 3 }}>
          <Editor
            height="140px"
            language={MEASURE_LANGUAGE_ID}
            value={formula}
            onChange={(v) => {
              setFormula(v ?? "");
              setMarker(null, null);
            }}
            onMount={handleMount}
            options={{
              minimap: { enabled: false },
              lineNumbers: "off",
              fontSize: 13,
              wordWrap: "on",
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      </Field>

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: 8, fontSize: 12 }}>{status}</div>}
    </Modal>
  );
}
