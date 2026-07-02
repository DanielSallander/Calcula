// FILENAME: app/extensions/ModelEditor/components/MeasureEditorDialog.tsx
// PURPOSE: Monaco-based editor for ONE model measure (add or edit). Validates
//          through the engine parser (positioned markers) and installs the
//          edit via bi_model_upsert_measure on save.

import React, { useCallback, useRef, useState } from "react";
import Editor, { type OnMount, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { DialogProps, ModelMeasureInfo } from "@api";
import {
  biModelUpsertMeasure,
  biModelValidateMeasure,
  emitAppEvent,
  recalcWithCube,
} from "@api";

// Preserve any prior worker handler (Charts JSON, CustomFunctions TS, ...) so
// this editor never clobbers another extension's Monaco setup.
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

export function MeasureEditorDialog({ onClose, data }: DialogProps) {
  const connectionId = (data?.connectionId as string) ?? "";
  const existing = data?.measure as ModelMeasureInfo | undefined;

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
  };

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
      await biModelUpsertMeasure({
        connectionId,
        originalName: existing?.name ?? null,
        name,
        formula,
        description: description.trim() || null,
        formatString: formatString.trim() || null,
      });
      // The model changed: let the panel reload, and force CUBE cells to
      // re-evaluate against the updated model.
      emitAppEvent("bi:model-changed", { connectionId });
      void recalcWithCube();
      onClose();
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [connectionId, existing, name, formula, description, formatString, onClose]);

  const fieldStyle: React.CSSProperties = {
    display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px",
  };
  const inputStyle: React.CSSProperties = {
    padding: "4px 6px", border: "1px solid #ccc", borderRadius: "3px", fontSize: "13px",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0, 0, 0, 0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        style={{
          padding: "16px",
          width: "560px",
          background: "#fff",
          borderRadius: "6px",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.25)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
      <h3 style={{ margin: "0 0 4px 0" }}>
        {existing ? `Edit Measure: ${existing.name}` : "New Measure"}
      </h3>
      <div style={{ fontSize: "12px", opacity: 0.7, marginBottom: "12px" }}>
        Model measures are part of the connection&apos;s model — they persist in
        this workbook and ship when the model is published as a package.
      </div>
      {existing && !existing.hasSource && (
        <div style={{
          fontSize: "12px", padding: "6px 8px", marginBottom: "8px",
          backgroundColor: "#fff3cd", borderRadius: 4,
        }}>
          This formula was reconstructed from the stored model (no original
          text). If you save without changing it, the stored definition is
          kept as-is; edit it only if you intend to redefine the measure.
        </div>
      )}

      <div style={{ display: "flex", gap: "8px" }}>
        <div style={{ ...fieldStyle, flex: 2 }}>
          <label>Name</label>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Revenue" />
        </div>
        <div style={{ ...fieldStyle, flex: 1 }}>
          <label>Format (optional)</label>
          <input style={inputStyle} value={formatString}
            onChange={(e) => setFormatString(e.target.value)} placeholder="#,##0.00" />
        </div>
      </div>
      <div style={fieldStyle}>
        <label>Description (optional)</label>
        <input style={inputStyle} value={description}
          onChange={(e) => setDescription(e.target.value)} />
      </div>

      <div style={fieldStyle}>
        <label>Formula</label>
        <div style={{ border: "1px solid #ccc", borderRadius: "3px" }}>
          <Editor
            height="140px"
            language="plaintext"
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
        <div style={{ fontSize: "11px", opacity: 0.6 }}>
          e.g. SUM(Sales[amount]) or ([Profit] / [Revenue]) * SUM(Sales[qty]) —
          reference other measures as [Name], columns as Table[column].
        </div>
      </div>

      {error && <div style={{ color: "red", marginBottom: "8px", fontSize: "12px" }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: "8px", fontSize: "12px" }}>{status}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={() => void handleValidate()}>Validate</button>
        <button
          onClick={() => void handleSave()}
          style={{ fontWeight: 600 }}
          disabled={busy || !name.trim() || !formula.trim() || !connectionId}
        >
          {busy ? "Saving…" : "Save Measure"}
        </button>
      </div>
      </div>
    </div>
  );
}
