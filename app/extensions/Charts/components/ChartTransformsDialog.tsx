//! FILENAME: app/extensions/Charts/components/ChartTransformsDialog.tsx
// PURPOSE: Author user-defined SANDBOXED chart data transforms (Feature 1). A
//          transform is a TYPE (one definition, used by every chart whose
//          spec.transform[].type === transformType). Each body runs in a hardened
//          Worker realm (broker capabilities + audit) and is a pure data->data
//          step the chart reader awaits IN PIPELINE ORDER. Saved with the workbook.
//          Mirrors the Chart Marks / Custom Functions manage dialogs.

import React, { useEffect, useMemo, useState } from "react";
import {
  type DialogProps,
  loadPersistedTransformLibrary,
  savePersistedTransformLibrary,
  installChartTransformLibrary,
  validateTransformType,
  showToast,
  TRANSFORM_TYPE_PREFIX,
  type ChartTransformScript,
  type ChartTransformLibrary,
} from "@api";
import { invalidateAllChartCaches } from "../rendering/chartRenderer";

/** A starter body: drop rows whose first series value is below a param/threshold,
 *  so "New" produces a working, illustrative pure data->data transform. */
const SCAFFOLD_BODY = `// data: { categories: string[], series: [{ name, values, color? }] }
// spec: this transform object   params: { ...named chart params }
// Return a new ParsedChartData. Example — keep the top half by series[0]:
const s0 = (data.series[0] && data.series[0].values) || [];
const cutoff = Number(params.threshold) || 0;
const keep = data.categories.map((_, i) => (s0[i] || 0) >= cutoff);
return {
  categories: data.categories.filter((_, i) => keep[i]),
  series: data.series.map((s) => ({ ...s, values: s.values.filter((_, i) => keep[i]) })),
};`;

function blankTransform(n: number): ChartTransformScript {
  return { type: `${TRANSFORM_TYPE_PREFIX}transform${n}`, label: `My Transform ${n}`, body: SCAFFOLD_BODY, description: "" };
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
  code: { fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: 12.5, minHeight: 200, resize: "vertical", whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto", padding: "8px", border: "1px solid var(--border, #ccc)", borderRadius: 4, background: "var(--input-bg, #fff)", color: "inherit" },
  foot: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px 16px", borderTop: "1px solid var(--border, #e2e2e2)" },
  btn: { padding: "7px 14px", borderRadius: 4, border: "1px solid var(--border, #ccc)", cursor: "pointer", fontSize: 13 },
  btnPrimary: { padding: "7px 14px", borderRadius: 4, border: "none", background: "var(--accent, #2563eb)", color: "#fff", cursor: "pointer", fontSize: 13 },
  smallBtn: { padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border, #ccc)", cursor: "pointer", fontSize: 12 },
  hint: { fontSize: 11, color: "var(--text-muted, #888)" },
  error: { color: "#c00", fontSize: 12, padding: "0 20px", whiteSpace: "pre-wrap" },
};

export function ChartTransformsDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const [transforms, setTransforms] = useState<ChartTransformScript[]>([]);
  const [biAccess, setBiAccess] = useState(false);
  const [selected, setSelected] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    loadPersistedTransformLibrary().then((lib) => {
      if (cancelled) return;
      setTransforms(lib?.transforms ?? []);
      setBiAccess((lib?.capabilities ?? []).includes("bi.query"));
      setSelected(0);
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  const current = transforms[selected];

  function patch(p: Partial<ChartTransformScript>): void {
    setTransforms((ts) => ts.map((t, i) => (i === selected ? { ...t, ...p } : t)));
  }
  function addTransform(): void {
    setTransforms((ts) => [...ts, blankTransform(ts.length + 1)]);
    setSelected(transforms.length);
  }
  function removeTransform(i: number): void {
    setTransforms((ts) => ts.filter((_, j) => j !== i));
    setSelected((s2) => Math.max(0, Math.min(s2, transforms.length - 2)));
  }

  const lib: ChartTransformLibrary = useMemo(
    () => ({
      transforms: transforms.map((t) => ({ ...t, type: t.type.trim() })),
      capabilities: biAccess ? ["bi.query"] : [],
    }),
    [transforms, biAccess],
  );

  async function onSave(): Promise<void> {
    setError(null);
    const seen = new Set<string>();
    for (const t of lib.transforms) {
      if (!t.type) continue;
      const typeErr = validateTransformType(t.type);
      if (typeErr) { setError(typeErr); return; }
      if (seen.has(t.type)) { setError(`Duplicate transform type "${t.type}".`); return; }
      seen.add(t.type);
      if (!t.body.trim()) { setError(`Transform "${t.type}" has an empty body.`); return; }
    }
    setSaving(true);
    try {
      const cleaned: ChartTransformLibrary = {
        transforms: lib.transforms.filter((t) => t.type && t.body.trim()),
        capabilities: lib.capabilities,
      };
      // Mount+install first (surfaces sandbox/compile errors before we persist),
      // then save with the workbook.
      await installChartTransformLibrary(cleaned);
      await savePersistedTransformLibrary(cleaned);
      invalidateAllChartCaches();
      showToast(`Saved ${cleaned.transforms.length} chart transform(s)`, { type: "success" });
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
          <h2 style={s.title}>Chart Transforms</h2>
          <p style={s.sub}>
            Author custom data transforms that run in a sandboxed worker. Use one in a
            chart by adding <code>{"{ \"type\": \"sandbox:…\" }"}</code> to its transform pipeline.
          </p>
        </div>

        <div style={s.bodyWrap}>
          <div style={s.list}>
            {transforms.map((t, i) => (
              <div key={i} style={listItemStyle(i === selected)} onClick={() => setSelected(i)} title={t.type}>
                {t.label || t.type || "(unnamed)"}
              </div>
            ))}
            <button style={{ ...s.smallBtn, marginTop: 6, width: "100%" }} onClick={addTransform}>
              + Add transform
            </button>
          </div>

          <div style={s.editor}>
            {current ? (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ ...s.row, flex: 1 }}>
                    <label style={s.label}>Type (spec.transform[].type)</label>
                    <input style={s.input} value={current.type} placeholder="sandbox:my-transform" onChange={(e) => patch({ type: e.target.value })} />
                  </div>
                  <div style={{ ...s.row, flex: 1 }}>
                    <label style={s.label}>Label</label>
                    <input style={s.input} value={current.label} onChange={(e) => patch({ label: e.target.value })} />
                  </div>
                </div>
                <div style={s.row}>
                  <label style={s.label}>Transform body (JavaScript — runs sandboxed, pure data→data)</label>
                  <textarea style={s.code} value={current.body} spellCheck={false} onChange={(e) => patch({ body: e.target.value })} />
                  <span style={s.hint}>
                    Available: <code>data</code> ({"{ categories, series }"}), <code>spec</code> (this transform), <code>params</code> (named chart params){biAccess ? <>, <code>cube</code> (BI model)</> : null}.
                    Must <code>return</code> a {"{ categories, series }"} object.
                  </span>
                </div>
                <div style={s.row}>
                  <label style={s.label}>Description</label>
                  <input style={s.input} value={current.description ?? ""} onChange={(e) => patch({ description: e.target.value })} />
                </div>
                <button style={s.smallBtn} onClick={() => removeTransform(selected)}>Delete this transform</button>
              </>
            ) : (
              <div style={s.hint}>No transforms yet. Click "Add transform".</div>
            )}
          </div>
        </div>

        {error && <div style={s.error}>{error}</div>}

        <div style={s.foot}>
          <label style={{ ...s.hint, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={biAccess} onChange={(e) => setBiAccess(e.target.checked)} />
            BI model access (<code>cube.*</code>)
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={s.btn} onClick={onClose}>Cancel</button>
            <button style={s.btnPrimary} disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
