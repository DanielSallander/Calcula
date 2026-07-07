//! FILENAME: app/extensions/CubeFormulas/components/CalculatedMeasuresDialog.tsx
// PURPOSE: Manage workbook-local calculated measures for a BI connection.
// CONTEXT: Lists/edits name+expression rows, saves via biSetCalculatedMeasures
//          (validated + applied to the engine so CUBE formulas / pivots use them).
//          Measures must reference columns (e.g. SUM(Sales[profit])/SUM(Sales[revenue])).

import React, { useEffect, useMemo, useState } from "react";
import {
  type DialogProps,
  biGetConnections,
  biGetModelInfo,
  biGetCalculatedMeasures,
  biSetCalculatedMeasures,
  recalcWithCube,
  showToast,
  type ConnectionInfo,
  type BiModelInfo,
  type CalculatedMeasure,
} from "@api";

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  card: {
    background: "var(--surface, #fff)",
    color: "var(--text, #1a1a1a)",
    borderRadius: 8,
    width: 620,
    maxHeight: "85vh",
    overflowY: "auto",
    boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
    padding: 20,
    fontSize: 13,
  },
  title: { margin: "0 0 4px", fontSize: 16, fontWeight: 600 },
  sub: { margin: "0 0 12px", fontSize: 12, color: "var(--text-muted, #777)" },
  row: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: 600, color: "var(--text-muted, #555)" },
  input: {
    padding: "6px 8px",
    border: "1px solid var(--border, #ccc)",
    borderRadius: 4,
    background: "var(--input-bg, #fff)",
    color: "inherit",
    fontSize: 13,
  },
  measureRow: { display: "flex", gap: 6, alignItems: "center", marginBottom: 6 },
  nameInput: { width: 150 },
  exprInput: { flex: 1, fontFamily: "monospace" },
  footer: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 },
  btn: {
    padding: "7px 14px",
    borderRadius: 4,
    border: "1px solid var(--border, #ccc)",
    cursor: "pointer",
    fontSize: 13,
  },
  btnPrimary: {
    padding: "7px 14px",
    borderRadius: 4,
    border: "none",
    background: "var(--accent, #2563eb)",
    color: "#fff",
    cursor: "pointer",
    fontSize: 13,
  },
  smallBtn: {
    padding: "2px 8px",
    borderRadius: 4,
    border: "1px solid var(--border, #ccc)",
    cursor: "pointer",
    fontSize: 12,
  },
  hint: { fontSize: 11, color: "var(--text-muted, #888)" },
  error: { color: "#c00", fontSize: 12, marginTop: 6, whiteSpace: "pre-wrap" },
};

export function CalculatedMeasuresDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose } = props;

  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [connId, setConnId] = useState("");
  const [model, setModel] = useState<BiModelInfo | null>(null);
  const [measures, setMeasures] = useState<CalculatedMeasure[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const connName = useMemo(
    () => connections.find((c) => c.id === connId)?.name ?? "",
    [connections, connId],
  );

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    biGetConnections()
      .then((conns) => {
        if (cancelled) return;
        setConnections(conns);
        if (conns.length && !connId) setConnId(conns[0].id);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !connId) return;
    let cancelled = false;
    setError(null);
    setModel(null); // avoid showing the previous connection's measures while loading
    biGetModelInfo(connId)
      .then((m) => !cancelled && setModel(m))
      .catch(() => {});
    biGetCalculatedMeasures(connId)
      .then((m) => !cancelled && setMeasures(m))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [isOpen, connId]);

  async function onSave(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      const cleaned = measures
        .map((m) => ({ name: m.name.trim(), expression: m.expression.trim() }))
        .filter((m) => m.name || m.expression);
      await biSetCalculatedMeasures(connId, cleaned);
      // Refresh existing CUBE formula cells against the new model (pivots refresh
      // on their next query). Best-effort — don't block the save on a recalc error.
      try {
        await recalcWithCube();
      } catch (e) {
        console.warn("[cube] recalc after measure change failed", e);
      }
      showToast("Calculated measures saved", { type: "success" });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen) return null;

  // The live model includes the user's calculated measures (they're baked in);
  // show only the base-model measures the user must avoid colliding with.
  const calcNames = new Set(measures.map((m) => m.name.trim()).filter(Boolean));
  const existingMeasureNames = (model?.measures ?? [])
    .filter((m) => !calcNames.has(m.name))
    .map((m) => m.name)
    .join(", ");

  return (
    <div style={s.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.card}>
        <h2 style={s.title}>Calculated Measures</h2>
        <p style={s.sub}>
          Define measures in column form, e.g. <code>SUM(Sales[profit]) / SUM(Sales[revenue])</code>.
          They become usable in CUBE formulas, pivots, and the <code>cube.*</code> script API.
        </p>
        <p style={s.sub}>
          Use <code>GVAR</code> for a query-scoped value — evaluated once per query (ignores the row
          axis, respects slicers) — for a share-of-total, e.g.{" "}
          <code>GVAR grand = SUM(Sales[amount]) RETURN DIVIDE(SUM(Sales[amount]), grand)</code>. In
          the spreadsheet, GVAR measures resolve in pivots; in a CUBE formula cell they are not
          supported yet and return an error.
        </p>

        <div style={s.row}>
          <label style={s.label}>Connection</label>
          <select style={s.input} value={connId} onChange={(e) => setConnId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {connections.length === 0 && (
            <span style={s.hint}>No BI connections — create one via Data ▸ External Data.</span>
          )}
        </div>

        <div style={s.row}>
          <label style={s.label}>Measures for {connName || "this model"}</label>
          {measures.map((m, i) => (
            <div key={i} style={s.measureRow}>
              <input
                style={{ ...s.input, ...s.nameInput }}
                placeholder="Name"
                value={m.name}
                onChange={(e) =>
                  setMeasures((ms) => ms.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
              <span style={{ color: "#999" }}>=</span>
              <input
                style={{ ...s.input, ...s.exprInput }}
                placeholder="SUM(Table[col]) / SUM(Table[col2])"
                value={m.expression}
                onChange={(e) =>
                  setMeasures((ms) =>
                    ms.map((x, j) => (j === i ? { ...x, expression: e.target.value } : x)),
                  )
                }
              />
              <button
                style={s.smallBtn}
                title="Remove"
                onClick={() => setMeasures((ms) => ms.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            style={s.smallBtn}
            onClick={() => setMeasures((ms) => [...ms, { name: "", expression: "" }])}
          >
            + Add measure
          </button>
          {existingMeasureNames && (
            <span style={{ ...s.hint, marginTop: 4 }}>Model measures: {existingMeasureNames}</span>
          )}
        </div>

        {error && <div style={s.error}>{error}</div>}

        <div style={s.footer}>
          <span style={s.hint}>
            Saved with the workbook. Invalid definitions are rejected without changing the model.
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={s.btn} onClick={onClose}>
              Cancel
            </button>
            <button style={s.btnPrimary} disabled={saving || !connId} onClick={onSave}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
