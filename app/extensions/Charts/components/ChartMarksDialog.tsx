//! FILENAME: app/extensions/Charts/components/ChartMarksDialog.tsx
// PURPOSE: Author user-defined SANDBOXED chart marks (B8.D.3). A mark is a TYPE
//          (one definition, used by every chart whose spec.mark === markId). Each
//          mark's body runs in a hardened Worker realm with NO capability (paint-
//          only); the host clips its rendered ImageBitmap to the plot rect. Saved
//          with the workbook. Mirrors the Custom Functions manage dialog.

import React, { useEffect, useMemo, useState } from "react";
import {
  type DialogProps,
  loadPersistedMarkLibrary,
  savePersistedMarkLibrary,
  installChartMarkLibrary,
  validateMarkId,
  showToast,
  MARK_ID_PREFIX,
  requestOverlayRedraw,
  type ChartMarkScript,
  type ChartMarkLibrary,
  type MarkLayoutFamily,
} from "@api";
import { registerSandboxMark } from "../rendering/sandboxMarkShim";
import { invalidateAllChartCaches } from "../rendering/chartRenderer";

/** A starter body: a simple data-driven bar mark, so "New" produces something
 *  that paints immediately and shows how to read paint.data. */
const SCAFFOLD_BODY = `// ctx: OffscreenCanvas 2D context (origin 0,0).
// paint: { spec, data, layout, theme }   b: { x:0, y:0, width, height } (plot)
const s = (paint.data.series && paint.data.series[0]) || { values: [] };
const vals = s.values || [];
const max = Math.max(1, ...vals.map((v) => Math.abs(v) || 0));
const bw = b.width / Math.max(1, vals.length);
ctx.fillStyle = (paint.theme && paint.theme.axisColor) || "#4E79A7";
vals.forEach((v, i) => {
  const h = (Math.abs(v) / max) * (b.height - 4);
  ctx.fillRect(i * bw + 2, b.height - h, Math.max(1, bw - 4), h);
});`;

function blankMark(n: number): ChartMarkScript {
  return { markId: `${MARK_ID_PREFIX}mark${n}`, label: `My Mark ${n}`, layoutFamily: "cartesian", body: SCAFFOLD_BODY, description: "" };
}

function listItemStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 8px", borderRadius: 4, cursor: "pointer", fontFamily: "monospace",
    fontSize: 12, background: active ? "var(--accent, #2563eb)" : "transparent",
    color: active ? "#fff" : "inherit", marginBottom: 2,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  };
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  card: { background: "var(--surface, #fff)", color: "var(--text, #1a1a1a)", borderRadius: 8, width: 720, maxHeight: "86vh", display: "flex", flexDirection: "column", boxShadow: "0 10px 40px rgba(0,0,0,0.25)", fontSize: 13 },
  head: { padding: "16px 20px 8px" },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  sub: { margin: "4px 0 0", fontSize: 12, color: "var(--text-muted, #777)" },
  bodyWrap: { display: "flex", gap: 0, flex: 1, minHeight: 300, overflow: "hidden" },
  list: { width: 180, borderRight: "1px solid var(--border, #e2e2e2)", overflowY: "auto", padding: "8px" },
  editor: { flex: 1, padding: "10px 16px", overflowY: "auto" },
  row: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: 600, color: "var(--text-muted, #555)" },
  input: { padding: "6px 8px", border: "1px solid var(--border, #ccc)", borderRadius: 4, background: "var(--input-bg, #fff)", color: "inherit", fontSize: 13 },
  code: { fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: 12.5, minHeight: 180, resize: "vertical", whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto", padding: "8px", border: "1px solid var(--border, #ccc)", borderRadius: 4, background: "var(--input-bg, #fff)", color: "inherit" },
  foot: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px 16px", borderTop: "1px solid var(--border, #e2e2e2)" },
  btn: { padding: "7px 14px", borderRadius: 4, border: "1px solid var(--border, #ccc)", cursor: "pointer", fontSize: 13 },
  btnPrimary: { padding: "7px 14px", borderRadius: 4, border: "none", background: "var(--accent, #2563eb)", color: "#fff", cursor: "pointer", fontSize: 13 },
  smallBtn: { padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border, #ccc)", cursor: "pointer", fontSize: 12 },
  hint: { fontSize: 11, color: "var(--text-muted, #888)" },
  error: { color: "#c00", fontSize: 12, padding: "0 20px", whiteSpace: "pre-wrap" },
};

export function ChartMarksDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const [marks, setMarks] = useState<ChartMarkScript[]>([]);
  const [selected, setSelected] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    loadPersistedMarkLibrary().then((lib) => {
      if (cancelled) return;
      setMarks(lib?.marks ?? []);
      setSelected(0);
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  const current = marks[selected];

  function patch(p: Partial<ChartMarkScript>): void {
    setMarks((ms) => ms.map((m, i) => (i === selected ? { ...m, ...p } : m)));
  }
  function addMark(): void {
    setMarks((ms) => [...ms, blankMark(ms.length + 1)]);
    setSelected(marks.length);
  }
  function removeMark(i: number): void {
    setMarks((ms) => ms.filter((_, j) => j !== i));
    setSelected((s2) => Math.max(0, Math.min(s2, marks.length - 2)));
  }

  const lib: ChartMarkLibrary = useMemo(
    () => ({ marks: marks.map((m) => ({ ...m, markId: m.markId.trim() })) }),
    [marks],
  );

  async function onSave(): Promise<void> {
    setError(null);
    const seen = new Set<string>();
    for (const m of lib.marks) {
      if (!m.markId) continue;
      const idErr = validateMarkId(m.markId);
      if (idErr) { setError(idErr); return; }
      if (seen.has(m.markId)) { setError(`Duplicate mark id "${m.markId}".`); return; }
      seen.add(m.markId);
      if (!m.body.trim()) { setError(`Mark "${m.markId}" has an empty body.`); return; }
    }
    setSaving(true);
    try {
      const cleaned: ChartMarkLibrary = { marks: lib.marks.filter((m) => m.markId && m.body.trim()) };
      // Mount+register first (surfaces sandbox/compile errors before we persist),
      // then save with the workbook. registerSandboxMark is the Charts-side registrar.
      await installChartMarkLibrary(cleaned, registerSandboxMark);
      await savePersistedMarkLibrary(cleaned);
      invalidateAllChartCaches();
      requestOverlayRedraw();
      showToast(`Saved ${cleaned.marks.length} chart mark(s)`, { type: "success" });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div style={s.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.card}>
        <div style={s.head}>
          <h2 style={s.title}>Chart Marks</h2>
          <p style={s.sub}>
            Author custom chart types that paint in a sandboxed worker (no network/disk —
            paint only). Use one in a chart by setting its <code>mark</code> to the id.
          </p>
        </div>

        <div style={s.bodyWrap}>
          <div style={s.list}>
            {marks.map((m, i) => (
              <div key={i} style={listItemStyle(i === selected)} onClick={() => setSelected(i)} title={m.markId}>
                {m.label || m.markId || "(unnamed)"}
              </div>
            ))}
            <button style={{ ...s.smallBtn, marginTop: 6, width: "100%" }} onClick={addMark}>
              + Add mark
            </button>
          </div>

          <div style={s.editor}>
            {current ? (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ ...s.row, flex: 1 }}>
                    <label style={s.label}>Mark id (spec.mark)</label>
                    <input style={s.input} value={current.markId} placeholder="sandbox:my-mark" onChange={(e) => patch({ markId: e.target.value })} />
                  </div>
                  <div style={{ ...s.row, flex: 1 }}>
                    <label style={s.label}>Label</label>
                    <input style={s.input} value={current.label} onChange={(e) => patch({ label: e.target.value })} />
                  </div>
                  <div style={{ ...s.row, width: 120 }}>
                    <label style={s.label}>Axes</label>
                    <select style={s.input} value={current.layoutFamily} onChange={(e) => patch({ layoutFamily: e.target.value as MarkLayoutFamily })}>
                      <option value="cartesian">cartesian</option>
                      <option value="radial">radial</option>
                      <option value="other">other</option>
                    </select>
                  </div>
                </div>
                <div style={s.row}>
                  <label style={s.label}>Paint body (JavaScript — runs sandboxed, paint only)</label>
                  <textarea style={s.code} value={current.body} spellCheck={false} onChange={(e) => patch({ body: e.target.value })} />
                  <span style={s.hint}>
                    Available: <code>ctx</code> (2D context), <code>paint</code> ({"{ spec, data, layout, theme }"}), <code>b</code> ({"{ x, y, width, height }"}).
                  </span>
                </div>
                <div style={s.row}>
                  <label style={s.label}>Description</label>
                  <input style={s.input} value={current.description ?? ""} onChange={(e) => patch({ description: e.target.value })} />
                </div>
                <button style={s.smallBtn} onClick={() => removeMark(selected)}>Delete this mark</button>
              </>
            ) : (
              <div style={s.hint}>No marks yet. Click "Add mark".</div>
            )}
          </div>
        </div>

        {error && <div style={s.error}>{error}</div>}

        <div style={s.foot}>
          <span style={s.hint}>Marks are saved with the workbook and run sandboxed.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={s.btn} onClick={onClose}>Cancel</button>
            <button style={s.btnPrimary} disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
