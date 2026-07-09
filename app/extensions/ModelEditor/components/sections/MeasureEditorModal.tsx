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
import { NUMBER_FORMAT_PRESETS } from "../../../_shared/components/NumberFormatModal";
import {
  MEASURE_LANGUAGE_ID,
  registerMeasureLanguage,
  setMeasureLanguageContext,
} from "../../lib/measureLanguage";

/** Best-effort preview of a number-format code applied to a sample value.
 *  Covers the common cases (decimals, thousands grouping, %, currency prefix);
 *  the authoritative formatting still happens in the engine. */
function previewFormat(value: number, fmt: string): string {
  const f = fmt.trim();
  if (!f) return String(value); // General
  const isPercent = f.includes("%");
  const n = isPercent ? value * 100 : value;
  const dot = f.indexOf(".");
  const decimals = dot >= 0 ? (f.slice(dot + 1).match(/[0#]/g)?.length ?? 0) : 0;
  const grouping = f.replace(/\[[^\]]*\]/g, "").includes(",");
  let prefix = "";
  const cur = /\[\$([^\]]+)\]/.exec(f);
  if (cur) prefix = `${cur[1].split("-")[0].trim()} `;
  else if (f.includes("$")) prefix = "$";
  const body = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  }).format(n);
  return `${prefix}${body}${isPercent ? "%" : ""}`;
}

/** Preset dropdown + custom code + live preview for a measure's number format. */
function FormatField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  const isPreset = NUMBER_FORMAT_PRESETS.some((p) => p.value === value);
  const [custom, setCustom] = useState(!isPreset && value !== "");
  const sample = value.includes("%") ? 0.1235 : 1234.567;
  return (
    <Field label="Format (optional)">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select
          style={{ ...styles.input, maxWidth: 340 }}
          value={custom ? "__custom__" : value}
          onChange={(e) => {
            if (e.target.value === "__custom__") {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(e.target.value);
            }
          }}
        >
          {NUMBER_FORMAT_PRESETS.map((p) => (
            <option key={p.value || "general"} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
        {custom && (
          <input
            style={{ ...styles.input, flex: 1, minWidth: 120, fontFamily: "monospace" }}
            value={value}
            placeholder="#,##0.00"
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        <span style={{ ...styles.muted, fontSize: 12, whiteSpace: "nowrap" }}>
          Preview: <strong style={{ color: "#222" }}>{previewFormat(sample, value)}</strong>
        </span>
      </div>
    </Field>
  );
}

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
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, byteOffset)).length;
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

  // Insert a reference (from the tree) into the editor — at a drop position
  // when dropped, otherwise replacing the current selection / at the cursor.
  const insertRef = useCallback(
    (text: string, at?: monaco.IPosition) => {
      const editor = editorRef.current;
      if (!editor) return;
      const range = at
        ? new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column)
        : (editor.getSelection() ?? new monaco.Range(1, 1, 1, 1));
      editor.executeEdits("tree-insert", [{ range, text, forceMoveMarkers: true }]);
      editor.pushUndoStop();
      editor.focus();
      setFormula(editor.getValue());
      setMarker(null, null);
    },
    [setMarker],
  );

  const handleEditorDrop = useCallback(
    (e: React.DragEvent) => {
      const text = e.dataTransfer.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const editor = editorRef.current;
      const target = editor?.getTargetAtClientPoint(e.clientX, e.clientY);
      insertRef(text, target?.position ?? undefined);
    },
    [insertRef],
  );

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
      width={900}
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
        Model measures are part of the connection&apos;s model — they persist in this workbook and
        ship when the model is published as a package.
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
          This formula was reconstructed from the stored model (no original text). If you save
          without changing it, the stored definition is kept as-is; edit it only if you intend to
          redefine the measure.
        </div>
      )}

      <Field label="Name">
        <input
          style={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Revenue"
        />
      </Field>
      <Field label="Description (optional)">
        <input
          style={styles.input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <FormatField value={formatString} onChange={setFormatString} />

      <Field
        label="Formula"
        hint="e.g. SUM(Sales[amount]) or ([Profit] / [Revenue]) * SUM(Sales[qty]) — reference other measures as [Name], columns as Table[column]. Use GVAR for a query-scoped value (evaluated once per query, ignores the row axis, respects slicers) — e.g. GVAR grand = SUM(Sales[amount]) RETURN DIVIDE(SUM(Sales[amount]), grand)."
      >
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <MeasureTreePanel overview={overview} onInsert={insertRef} />
          <div
            style={{ flex: 1, minWidth: 0, border: "1px solid #ccc", borderRadius: 3 }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleEditorDrop}
          >
            <Editor
              height="320px"
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
        </div>
      </Field>

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
      {status && <div style={{ color: "green", marginBottom: 8, fontSize: 12 }}>{status}</div>}
    </Modal>
  );
}

/** Explorable tree of the model's tables/columns/measures. Click a leaf to
 *  insert its reference at the cursor, or drag it onto the editor. */
function MeasureTreePanel({
  overview,
  onInsert,
}: {
  overview: ModelOverview;
  onInsert: (ref: string) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const onDragRef = (e: React.DragEvent, text: string) => {
    e.dataTransfer.setData("text/plain", text);
    e.dataTransfer.effectAllowed = "copy";
  };
  const headerStyle: React.CSSProperties = {
    padding: "4px 8px",
    fontWeight: 600,
    color: "#555",
    borderBottom: "1px solid #eee",
    position: "sticky",
    top: 0,
    background: "#f2f2f2",
  };
  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 6px",
    cursor: "grab",
    userSelect: "none",
  };

  return (
    <div
      style={{
        width: 240,
        flexShrink: 0,
        border: "1px solid #ddd",
        borderRadius: 3,
        overflowY: "auto",
        fontSize: 12,
        background: "#fafafa",
      }}
    >
      <div style={headerStyle}>Tables &amp; columns</div>
      {overview.tables.length === 0 && (
        <div style={{ padding: "6px 8px", color: "#999" }}>No tables yet.</div>
      )}
      {overview.tables.map((t) => {
        const open = expanded.has(t.name);
        return (
          <div key={t.name}>
            <div
              style={{ ...rowStyle, cursor: "pointer", fontWeight: 600 }}
              draggable
              onDragStart={(e) => onDragRef(e, t.name)}
              onClick={() => toggle(t.name)}
              title="Click to expand; drag to insert the table name"
            >
              <span style={{ width: 12, color: "#888" }}>{open ? "▾" : "▸"}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.name}
              </span>
            </div>
            {open &&
              t.columns.map((c) => (
                <div
                  key={c.name}
                  style={{ ...rowStyle, paddingLeft: 24 }}
                  draggable
                  onDragStart={(e) => onDragRef(e, `${t.name}[${c.name}]`)}
                  onClick={() => onInsert(`${t.name}[${c.name}]`)}
                  title={`Insert ${t.name}[${c.name}]`}
                >
                  <span style={{ color: c.isCalculated ? "#2f6fce" : "#aaa" }}>
                    {c.isCalculated ? "ƒ" : "▪"}
                  </span>
                  <span
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {c.name}
                  </span>
                  <span style={{ marginLeft: "auto", color: "#bbb", fontSize: 10, flexShrink: 0 }}>
                    {c.dataType}
                  </span>
                </div>
              ))}
          </div>
        );
      })}
      {overview.measures.length > 0 && (
        <>
          <div style={{ ...headerStyle, borderTop: "1px solid #eee" }}>Measures</div>
          {overview.measures.map((m) => (
            <div
              key={m.name}
              style={rowStyle}
              draggable
              onDragStart={(e) => onDragRef(e, `[${m.name}]`)}
              onClick={() => onInsert(`[${m.name}]`)}
              title={`Insert [${m.name}]`}
            >
              <span style={{ color: "#8a5cf6" }}>∑</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.name}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
