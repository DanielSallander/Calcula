//! FILENAME: app/extensions/CubeFormulas/components/CubeFormulaBuilderDialog.tsx
// PURPOSE: Dialog to build & insert a CUBE formula from a Calcula BI model.
// CONTEXT: Registered via context.ui.dialogs.register; opened from the Formulas
//          menu with { activeRow, activeCol }. Reads the model via biGetModelInfo,
//          builds the formula with buildCubeFormula, and inserts it into the
//          active cell via update_cell (which triggers the cube pre-fetch).

import React, { useEffect, useMemo, useState } from "react";
import {
  type DialogProps,
  biGetConnections,
  biGetModelInfo,
  biGetColumnValues,
  getLocaleSettings,
  updateCell,
  showToast,
  type ConnectionInfo,
  type BiModelInfo,
} from "@api";
import {
  buildCubeFormula,
  type CubeFormulaSpec,
  type CubeFunc,
  type MemberFilter,
} from "../lib/buildFormula";

const FUNCS: { value: CubeFunc; label: string }[] = [
  { value: "CUBEVALUE", label: "CUBEVALUE — aggregated value" },
  { value: "CUBEMEMBER", label: "CUBEMEMBER — a member/measure" },
  { value: "CUBESET", label: "CUBESET — a set of members" },
  { value: "CUBERANKEDMEMBER", label: "CUBERANKEDMEMBER — nth member of a set" },
  { value: "CUBESETCOUNT", label: "CUBESETCOUNT — count of a set" },
  { value: "CUBEMEMBERPROPERTY", label: "CUBEMEMBERPROPERTY — a member property" },
  { value: "CUBEKPIMEMBER", label: "CUBEKPIMEMBER — a KPI value/goal/status" },
];

interface ColumnRef {
  table: string;
  column: string;
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
    width: 560,
    maxHeight: "85vh",
    overflowY: "auto",
    boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
    padding: 20,
    fontSize: 13,
  },
  title: { margin: "0 0 12px", fontSize: 16, fontWeight: 600 },
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
  memberRow: { display: "flex", gap: 6, alignItems: "center", marginBottom: 6 },
  preview: {
    fontFamily: "monospace",
    fontSize: 12,
    background: "var(--code-bg, #f5f5f5)",
    border: "1px solid var(--border, #ddd)",
    borderRadius: 4,
    padding: "8px 10px",
    wordBreak: "break-all",
    minHeight: 18,
  },
  footer: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 },
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
  hint: { fontSize: 11, color: "var(--text-muted, #888)", marginTop: 2 },
};

export function CubeFormulaBuilderDialog(props: DialogProps): React.ReactElement | null {
  const { isOpen, onClose, data } = props;
  const activeRow = (data?.activeRow as number) ?? 0;
  const activeCol = (data?.activeCol as number) ?? 0;

  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [connId, setConnId] = useState<string>("");
  const [model, setModel] = useState<BiModelInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sep, setSep] = useState<string>(",");

  const [func, setFunc] = useState<CubeFunc>("CUBEVALUE");
  const [measure, setMeasure] = useState("");
  const [members, setMembers] = useState<MemberFilter[]>([]);
  const [memberKind, setMemberKind] = useState<"measure" | "member">("member");
  const [setCol, setSetCol] = useState<ColumnRef | null>(null);
  const [caption, setCaption] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [sortBy, setSortBy] = useState("");
  const [setRef, setSetRef] = useState("");
  const [rank, setRank] = useState(1);
  const [property, setProperty] = useState("");
  const [kpiName, setKpiName] = useState("");
  const [kpiProperty, setKpiProperty] = useState(1);

  // Cache of distinct column values for member-value pickers.
  const [valueCache, setValueCache] = useState<Record<string, string[]>>({});

  const connName = useMemo(
    () => connections.find((c) => c.id === connId)?.name ?? "",
    [connections, connId],
  );

  const allColumns = useMemo<ColumnRef[]>(() => {
    if (!model) return [];
    return model.tables.flatMap((t) => t.columns.map((c) => ({ table: t.name, column: c.name })));
  }, [model]);

  // Load connections + locale separator when opened.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    getLocaleSettings().then((l) => {
      if (!cancelled) setSep(l.listSeparator || ",");
    });
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

  // Load model info when the selected connection changes.
  useEffect(() => {
    if (!isOpen || !connId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    biGetModelInfo(connId)
      .then((m) => {
        if (cancelled) return;
        setModel(m);
        if (m?.measures.length) setMeasure((prev) => prev || m.measures[0].name);
        if (m?.kpis?.length) setKpiName((prev) => prev || m.kpis![0].name);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [isOpen, connId]);

  function loadValues(table: string, column: string): void {
    const key = `${table}.${column}`;
    if (valueCache[key] || !connId) return;
    biGetColumnValues(connId, table, column)
      .then((vals) => setValueCache((c) => ({ ...c, [key]: vals })))
      .catch(() => setValueCache((c) => ({ ...c, [key]: [] })));
  }

  const spec: CubeFormulaSpec = {
    func,
    connection: connName,
    measure: measure || undefined,
    members,
    setTable: setCol?.table,
    setColumn: setCol?.column,
    caption: caption || undefined,
    sortOrder,
    sortBy: sortBy || undefined,
    setRef: setRef || undefined,
    rank,
    property: property || undefined,
    kpiName: kpiName || undefined,
    kpiProperty,
  };
  // CUBEMEMBER: a measure member vs a dimension member.
  if (func === "CUBEMEMBER" && memberKind === "measure") spec.members = [];
  if (func === "CUBEMEMBER" && memberKind === "member") spec.measure = undefined;

  const formula = buildCubeFormula(spec, sep);

  async function onInsert(): Promise<void> {
    if (!formula) return;
    try {
      await updateCell(activeRow, activeCol, formula);
      onClose();
    } catch (e) {
      showToast(`Could not insert formula: ${e}`, { type: "error" });
    }
  }

  if (!isOpen) return null;

  const colKey = (c: ColumnRef) => `${c.table}.${c.column}`;
  const parseColKey = (k: string): ColumnRef | null => {
    const idx = k.indexOf(".");
    return idx < 0 ? null : { table: k.slice(0, idx), column: k.slice(idx + 1) };
  };

  function valueInput(m: MemberFilter, onChange: (v: string) => void): React.ReactElement {
    const key = `${m.table}.${m.column}`;
    const listId = `cube-vals-${key}`.replace(/[^a-zA-Z0-9-]/g, "_");
    return (
      <>
        <input
          style={{ ...s.input, flex: 1 }}
          placeholder="value"
          list={listId}
          value={m.value}
          onFocus={() => m.table && m.column && loadValues(m.table, m.column)}
          onChange={(e) => onChange(e.target.value)}
        />
        <datalist id={listId}>
          {(valueCache[key] ?? []).map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </>
    );
  }

  return (
    <div style={s.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.card}>
        <h2 style={s.title}>Insert CUBE Formula</h2>

        {error && <div style={{ color: "#c00", marginBottom: 10 }}>{error}</div>}
        {connections.length === 0 && !error && (
          <div style={s.hint}>
            No BI connections. Create one via Data ▸ External Data ▸ Get Data first.
          </div>
        )}

        <div style={s.row}>
          <label style={s.label}>Connection</label>
          <select style={s.input} value={connId} onChange={(e) => setConnId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.isConnected ? "" : "(offline)"}
              </option>
            ))}
          </select>
        </div>

        <div style={s.row}>
          <label style={s.label}>Function</label>
          <select style={s.input} value={func} onChange={(e) => setFunc(e.target.value as CubeFunc)}>
            {FUNCS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        {loading && <div style={s.hint}>Loading model…</div>}

        {/* ---- CUBEVALUE ---- */}
        {func === "CUBEVALUE" && (
          <>
            <div style={s.row}>
              <label style={s.label}>Measure</label>
              <select style={s.input} value={measure} onChange={(e) => setMeasure(e.target.value)}>
                <option value="">(model default)</option>
                {model?.measures.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={s.row}>
              <label style={s.label}>Member filters (slice the value)</label>
              {members.map((m, i) => (
                <div key={i} style={s.memberRow}>
                  <select
                    style={{ ...s.input, flex: 1 }}
                    value={m.table && m.column ? colKey(m) : ""}
                    onChange={(e) => {
                      const c = parseColKey(e.target.value);
                      setMembers((ms) =>
                        ms.map((x, j) =>
                          j === i ? { table: c?.table ?? "", column: c?.column ?? "", value: "" } : x,
                        ),
                      );
                      if (c) loadValues(c.table, c.column);
                    }}
                  >
                    <option value="">column…</option>
                    {allColumns.map((c) => (
                      <option key={colKey(c)} value={colKey(c)}>
                        {c.table}.{c.column}
                      </option>
                    ))}
                  </select>
                  {valueInput(m, (v) =>
                    setMembers((ms) => ms.map((x, j) => (j === i ? { ...x, value: v } : x))),
                  )}
                  <button
                    style={s.smallBtn}
                    onClick={() => setMembers((ms) => ms.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                style={s.smallBtn}
                onClick={() => setMembers((ms) => [...ms, { table: "", column: "", value: "" }])}
              >
                + Add filter
              </button>
            </div>
          </>
        )}

        {/* ---- CUBEMEMBER ---- */}
        {func === "CUBEMEMBER" && (
          <>
            <div style={s.row}>
              <label style={s.label}>Member kind</label>
              <select
                style={s.input}
                value={memberKind}
                onChange={(e) => setMemberKind(e.target.value as "measure" | "member")}
              >
                <option value="member">Dimension member</option>
                <option value="measure">Measure</option>
              </select>
            </div>
            {memberKind === "measure" ? (
              <div style={s.row}>
                <label style={s.label}>Measure</label>
                <select style={s.input} value={measure} onChange={(e) => setMeasure(e.target.value)}>
                  {model?.measures.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div style={s.row}>
                <label style={s.label}>Member</label>
                <div style={s.memberRow}>
                  <select
                    style={{ ...s.input, flex: 1 }}
                    value={members[0] && members[0].table ? colKey(members[0]) : ""}
                    onChange={(e) => {
                      const c = parseColKey(e.target.value);
                      setMembers([{ table: c?.table ?? "", column: c?.column ?? "", value: "" }]);
                      if (c) loadValues(c.table, c.column);
                    }}
                  >
                    <option value="">column…</option>
                    {allColumns.map((c) => (
                      <option key={colKey(c)} value={colKey(c)}>
                        {c.table}.{c.column}
                      </option>
                    ))}
                  </select>
                  {valueInput(members[0] ?? { table: "", column: "", value: "" }, (v) =>
                    setMembers((ms) => [{ ...(ms[0] ?? { table: "", column: "" }), value: v }]),
                  )}
                </div>
              </div>
            )}
            <CaptionInput value={caption} onChange={setCaption} />
          </>
        )}

        {/* ---- CUBESET ---- */}
        {func === "CUBESET" && (
          <>
            <div style={s.row}>
              <label style={s.label}>Level (all members of a column)</label>
              <select
                style={s.input}
                value={setCol ? colKey(setCol) : ""}
                onChange={(e) => setSetCol(parseColKey(e.target.value))}
              >
                <option value="">column…</option>
                {allColumns.map((c) => (
                  <option key={colKey(c)} value={colKey(c)}>
                    {c.table}.{c.column}
                  </option>
                ))}
              </select>
            </div>
            <div style={s.row}>
              <label style={s.label}>Sort</label>
              <select
                style={s.input}
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value))}
              >
                <option value={0}>None</option>
                <option value={1}>By measure, ascending</option>
                <option value={2}>By measure, descending</option>
                <option value={3}>Alphabetical, ascending</option>
                <option value={4}>Alphabetical, descending</option>
              </select>
            </div>
            {(sortOrder === 1 || sortOrder === 2) && (
              <div style={s.row}>
                <label style={s.label}>Sort by measure</label>
                <select style={s.input} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="">(model default)</option>
                  {model?.measures.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <CaptionInput value={caption} onChange={setCaption} />
          </>
        )}

        {/* ---- CUBERANKEDMEMBER / CUBESETCOUNT ---- */}
        {(func === "CUBERANKEDMEMBER" || func === "CUBESETCOUNT") && (
          <div style={s.row}>
            <label style={s.label}>Set cell reference (a CUBESET cell)</label>
            <input
              style={s.input}
              placeholder="e.g. D1"
              value={setRef}
              onChange={(e) => setSetRef(e.target.value.toUpperCase())}
            />
          </div>
        )}
        {func === "CUBERANKEDMEMBER" && (
          <>
            <div style={s.row}>
              <label style={s.label}>Rank (1 = top)</label>
              <input
                style={s.input}
                type="number"
                min={1}
                value={rank}
                onChange={(e) => setRank(Math.max(1, Number(e.target.value)))}
              />
            </div>
            <CaptionInput value={caption} onChange={setCaption} />
          </>
        )}

        {/* ---- CUBEMEMBERPROPERTY ---- */}
        {func === "CUBEMEMBERPROPERTY" && (
          <>
            <div style={s.row}>
              <label style={s.label}>Member</label>
              <div style={s.memberRow}>
                <select
                  style={{ ...s.input, flex: 1 }}
                  value={members[0] && members[0].table ? colKey(members[0]) : ""}
                  onChange={(e) => {
                    const c = parseColKey(e.target.value);
                    setMembers([{ table: c?.table ?? "", column: c?.column ?? "", value: "" }]);
                    if (c) loadValues(c.table, c.column);
                  }}
                >
                  <option value="">column…</option>
                  {allColumns.map((c) => (
                    <option key={colKey(c)} value={colKey(c)}>
                      {c.table}.{c.column}
                    </option>
                  ))}
                </select>
                {valueInput(members[0] ?? { table: "", column: "", value: "" }, (v) =>
                  setMembers((ms) => [{ ...(ms[0] ?? { table: "", column: "" }), value: v }]),
                )}
              </div>
            </div>
            <div style={s.row}>
              <label style={s.label}>Property (a column on the member's table)</label>
              <input
                style={s.input}
                placeholder="e.g. Region, or CAPTION"
                value={property}
                onChange={(e) => setProperty(e.target.value)}
              />
            </div>
          </>
        )}

        {/* ---- CUBEKPIMEMBER ---- */}
        {func === "CUBEKPIMEMBER" && (
          <>
            <div style={s.row}>
              <label style={s.label}>KPI</label>
              <select style={s.input} value={kpiName} onChange={(e) => setKpiName(e.target.value)}>
                {(model?.kpis ?? []).map((k) => (
                  <option key={k.name} value={k.name}>
                    {k.name}
                  </option>
                ))}
              </select>
              {(model?.kpis ?? []).length === 0 && (
                <span style={s.hint}>This model defines no KPIs.</span>
              )}
            </div>
            <div style={s.row}>
              <label style={s.label}>Property</label>
              <select
                style={s.input}
                value={kpiProperty}
                onChange={(e) => setKpiProperty(Number(e.target.value))}
              >
                <option value={1}>Value</option>
                <option value={2}>Goal</option>
                <option value={3}>Status</option>
              </select>
            </div>
            <CaptionInput value={caption} onChange={setCaption} />
          </>
        )}

        <div style={s.row}>
          <label style={s.label}>Preview</label>
          <div style={s.preview}>{formula || "—"}</div>
          <span style={s.hint}>
            Inserts into the active cell ({activeRow + 1}, {activeCol + 1}).
          </span>
        </div>

        <div style={s.footer}>
          <button style={s.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={s.btnPrimary} disabled={!formula} onClick={onInsert}>
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}

function CaptionInput(props: { value: string; onChange: (v: string) => void }): React.ReactElement {
  return (
    <div style={s.row}>
      <label style={s.label}>Caption (optional)</label>
      <input
        style={s.input}
        placeholder="display text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  );
}
