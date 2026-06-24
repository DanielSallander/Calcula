//! FILENAME: app/extensions/CustomFunctions/components/CustomFunctionsDialog.tsx
// PURPOSE: Author user-defined JS formula functions (UDFs). Each function's body
//          runs in a SANDBOXED worker (broker capabilities + audit), exposed as a
//          formula function (=NAME(args)). Bodies may call cube.value/kpi/members
//          when "BI model access" is granted. Saved with the workbook.

import React, { useEffect, useMemo, useState } from "react";
import {
  type DialogProps,
  loadPersistedLibrary,
  savePersistedLibrary,
  installCustomFunctions,
  validateFunctionName,
  validateParam,
  getAllFunctions,
  showToast,
  type CustomFunctionUdf,
  type CustomFunctionLibrary,
} from "@api";
import { CustomFunctionsCodeEditor } from "./CustomFunctionsCodeEditor";

const BLANK: CustomFunctionUdf = { name: "", params: [], body: "return ;", description: "" };

function listItemStyle(active: boolean): React.CSSProperties {
  return {
    padding: "6px 8px",
    borderRadius: 4,
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 12,
    background: active ? "var(--accent, #2563eb)" : "transparent",
    color: active ? "#fff" : "inherit",
    marginBottom: 2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

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
    width: 720,
    maxHeight: "86vh",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
    fontSize: 13,
  },
  head: { padding: "16px 20px 8px" },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  sub: { margin: "4px 0 0", fontSize: 12, color: "var(--text-muted, #777)" },
  bodyWrap: { display: "flex", gap: 0, flex: 1, minHeight: 280, overflow: "hidden" },
  list: {
    width: 180,
    borderRight: "1px solid var(--border, #e2e2e2)",
    overflowY: "auto",
    padding: "8px",
  },
  editor: { flex: 1, padding: "10px 16px", overflowY: "auto" },
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
  code: {
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: 12.5,
    minHeight: 150,
    resize: "vertical",
    whiteSpace: "pre",
    overflowWrap: "normal",
    overflowX: "auto",
  },
  foot: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "10px 20px 16px",
    borderTop: "1px solid var(--border, #e2e2e2)",
  },
  btn: { padding: "7px 14px", borderRadius: 4, border: "1px solid var(--border, #ccc)", cursor: "pointer", fontSize: 13 },
  btnPrimary: { padding: "7px 14px", borderRadius: 4, border: "none", background: "var(--accent, #2563eb)", color: "#fff", cursor: "pointer", fontSize: 13 },
  smallBtn: { padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border, #ccc)", cursor: "pointer", fontSize: 12 },
  hint: { fontSize: 11, color: "var(--text-muted, #888)" },
  error: { color: "#c00", fontSize: 12, padding: "0 20px", whiteSpace: "pre-wrap" },
};

export function CustomFunctionsDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose } = props;
  const [functions, setFunctions] = useState<CustomFunctionUdf[]>([]);
  const [biAccess, setBiAccess] = useState(true);
  const [selected, setSelected] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Upper-cased built-in function names — a UDF must not shadow one (the parser
  // resolves built-ins first, so a colliding UDF would silently never run).
  const [builtins, setBuiltins] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    loadPersistedLibrary().then((lib) => {
      if (cancelled) return;
      setFunctions(lib?.functions ?? []);
      setBiAccess((lib?.capabilities ?? ["bi.query"]).includes("bi.query"));
      setSelected(0);
    });
    getAllFunctions()
      .then((res) => {
        if (cancelled) return;
        setBuiltins(new Set(res.functions.map((f) => f.name.toUpperCase())));
      })
      .catch(() => {
        /* best-effort: collision check just won't fire */
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const current = functions[selected];

  function patch(p: Partial<CustomFunctionUdf>): void {
    setFunctions((fs) => fs.map((f, i) => (i === selected ? { ...f, ...p } : f)));
  }

  function addFn(): void {
    setFunctions((fs) => [...fs, { ...BLANK, name: `FUNC${fs.length + 1}` }]);
    setSelected(functions.length);
  }

  function removeFn(i: number): void {
    setFunctions((fs) => fs.filter((_, j) => j !== i));
    setSelected((s2) => Math.max(0, Math.min(s2, functions.length - 2)));
  }

  const lib: CustomFunctionLibrary = useMemo(
    () => ({
      functions: functions.map((f) => ({ ...f, name: f.name.trim() })),
      capabilities: biAccess ? ["bi.query"] : [],
    }),
    [functions, biAccess],
  );

  async function onSave(): Promise<void> {
    setError(null);
    // Validate names (non-empty, unique, JS-identifier, not a built-in) and params.
    const seen = new Set<string>();
    for (const f of lib.functions) {
      if (!f.name) continue;
      const nameErr = validateFunctionName(f.name);
      if (nameErr) {
        setError(nameErr);
        return;
      }
      const up = f.name.toUpperCase();
      if (builtins.has(up)) {
        setError(`"${f.name}" is a built-in function and cannot be overridden.`);
        return;
      }
      if (seen.has(up)) {
        setError(`Duplicate function name "${f.name}".`);
        return;
      }
      seen.add(up);
      for (const p of f.params) {
        const perr = validateParam(p.trim(), f.name);
        if (p.trim() && perr) {
          setError(perr);
          return;
        }
      }
    }
    setSaving(true);
    try {
      const cleaned: CustomFunctionLibrary = {
        functions: lib.functions.filter((f) => f.name && f.body.trim()),
        capabilities: lib.capabilities,
      };
      // Mount first (surfaces sandbox/compile errors before we persist), then save.
      // We deliberately do NOT force a recalc here: existing UDF cells keep their
      // last values (the engine preserves them when a definition is in flux), and
      // new/edited usages resolve on their next edit. Forcing a full recalc here
      // raced the just-mounted library and could blank cube/UDF cells.
      await installCustomFunctions(cleaned);
      await savePersistedLibrary(cleaned);
      showToast(`Saved ${cleaned.functions.length} custom function(s)`, { type: "success" });
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
          <h2 style={s.title}>Custom Functions</h2>
          <p style={s.sub}>
            Write JS functions usable in formulas (=NAME(args)). Bodies run sandboxed; grant
            BI access to call <code>cube.value("conn","[Measure]","T[C]=v")</code>.
          </p>
        </div>

        <div style={s.bodyWrap}>
          <div style={s.list}>
            {functions.map((f, i) => (
              <div
                key={i}
                style={listItemStyle(i === selected)}
                onClick={() => setSelected(i)}
                title={f.name}
              >
                {f.name || "(unnamed)"}
              </div>
            ))}
            <button style={{ ...s.smallBtn, marginTop: 6, width: "100%" }} onClick={addFn}>
              + Add function
            </button>
          </div>

          <div style={s.editor}>
            {current ? (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <div style={{ ...s.row, flex: 1 }}>
                    <label style={s.label}>Name</label>
                    <input
                      style={s.input}
                      value={current.name}
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                  </div>
                  <div style={{ ...s.row, flex: 2 }}>
                    <label style={s.label}>Parameters (comma-separated)</label>
                    <input
                      style={s.input}
                      placeholder="e.g. price, rate"
                      value={current.params.join(", ")}
                      onChange={(e) =>
                        patch({ params: e.target.value.split(",").map((p) => p.trim()).filter(Boolean) })
                      }
                    />
                  </div>
                </div>
                <div style={s.row}>
                  <label style={s.label}>Body (JavaScript — must return a value)</label>
                  <CustomFunctionsCodeEditor
                    value={current.body}
                    onChange={(body) => patch({ body })}
                  />
                  <span style={s.hint}>
                    Available: the parameters, <code>cube</code> (when BI access is on), and standard JS.
                  </span>
                </div>
                <div style={s.row}>
                  <label style={s.label}>Description (shown in autocomplete)</label>
                  <input
                    style={s.input}
                    value={current.description ?? ""}
                    onChange={(e) => patch({ description: e.target.value })}
                  />
                </div>
                <button style={s.smallBtn} onClick={() => removeFn(selected)}>
                  Delete this function
                </button>
              </>
            ) : (
              <div style={s.hint}>No functions yet. Click "Add function".</div>
            )}
          </div>
        </div>

        {error && <div style={s.error}>{error}</div>}

        <div style={s.foot}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={biAccess} onChange={(e) => setBiAccess(e.target.checked)} />
            Allow BI model access (cube.*)
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={s.btn} onClick={onClose}>
              Cancel
            </button>
            <button style={s.btnPrimary} disabled={saving} onClick={onSave}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
