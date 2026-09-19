//! FILENAME: app/extensions/CubeFormulas/components/CubeFormulaBuilderPanel.tsx
// PURPOSE: The argument builder for the seven CUBE functions — step 2 of Insert
//          Function, rendered inside the shell's fx dialog.
// CONTEXT: Registered through @api/functionBuilders by this extension's
//          activate(). It reads the live BI model (biGetModelInfo /
//          biGetColumnValues) so the user picks measures, columns, values and
//          KPIs from what the model actually holds, instead of typing Calcula's
//          member-expression syntax from memory and getting a silent #N/A.
//
//          WHICH FUNCTION IS NOT THIS PANEL'S DECISION ANY MORE. It arrives as
//          `context.functionName`, chosen in the fx catalog like any other
//          function; the panel used to own a function dropdown of its own
//          because it was opened from a menu item that named no function.
//
//          THE PANEL DOES NOT INSERT. It reports the formula through
//          `onFormulaChange` and the host commits it — see functionBuilders.ts
//          for why there is exactly one commit path.

import React, { useEffect, useMemo, useState } from "react";
import {
  biGetConnections,
  biGetModelInfo,
  biGetColumnValues,
  getLocaleSettings,
  type FunctionBuilderProps,
  type ConnectionInfo,
  type BiModelInfo,
} from "@api";
import {
  buildCubeFormula,
  type CubeFormulaSpec,
  type CubeFunc,
  type MemberFilter,
} from "../lib/buildFormula";

/** The names this builder is registered for, and the order the fx list shows. */
export const CUBE_FUNCTION_NAMES: CubeFunc[] = [
  "CUBEVALUE",
  "CUBEMEMBER",
  "CUBESET",
  "CUBESETCOUNT",
  "CUBERANKEDMEMBER",
  "CUBEMEMBERPROPERTY",
  "CUBEKPIMEMBER",
];

interface ColumnRef {
  table: string;
  column: string;
}

const s: Record<string, React.CSSProperties> = {
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
  smallBtn: {
    padding: "2px 8px",
    borderRadius: 4,
    border: "1px solid var(--border, #ccc)",
    cursor: "pointer",
    fontSize: 12,
  },
  hint: { fontSize: 11, color: "var(--text-muted, #888)", marginTop: 2 },
  error: { color: "#c00", marginBottom: 10, fontSize: 12 },
};

export function CubeFormulaBuilderPanel(props: FunctionBuilderProps): React.ReactElement {
  const { context, onFormulaChange, onSubmit } = props;
  const func = context.functionName.toUpperCase() as CubeFunc;

  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [connId, setConnId] = useState<string>("");
  const [model, setModel] = useState<BiModelInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sep, setSep] = useState<string>(",");

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

  // Load connections + locale separator on mount. The panel is mounted only
  // while step 2 is showing, so there is no open/closed state to gate on.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    getLocaleSettings().then((l) => {
      if (!cancelled) setSep(l.listSeparator || ",");
    });
    biGetConnections()
      .then((conns) => {
        if (cancelled) return;
        setConnections(conns);
        if (conns.length) setConnId((prev) => prev || conns[0].id);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  // Load model info when the selected connection changes.
  useEffect(() => {
    if (!connId) return;
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
  }, [connId]);

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

  // The host owns the preview and the Insert button, so every change is
  // reported. "" from the builder means "not insertable yet" — null is the
  // seam's spelling of that.
  useEffect(() => {
    onFormulaChange(formula || null);
  }, [formula, onFormulaChange]);

  const colKey = (c: ColumnRef) => `${c.table}.${c.column}`;
  const parseColKey = (k: string): ColumnRef | null => {
    const idx = k.indexOf(".");
    return idx < 0 ? null : { table: k.slice(0, idx), column: k.slice(idx + 1) };
  };

  /** Enter anywhere in a text field inserts, like any other form. */
  const submitOnEnter = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
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
          onKeyDown={submitOnEnter}
        />
        <datalist id={listId}>
          {(valueCache[key] ?? []).map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </>
    );
  }

  // CUBESETCOUNT takes only a set reference — no connection, so the picker
  // would be a control with no effect on the formula.
  const needsConnection = func !== "CUBESETCOUNT";

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}
      {needsConnection && connections.length === 0 && !error && (
        <div style={s.hint}>
          No BI connections. Create one via Data ▸ External Data ▸ Get Data first.
        </div>
      )}

      {needsConnection && (
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
      )}

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
          <CaptionInput value={caption} onChange={setCaption} onEnter={submitOnEnter} />
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
          <CaptionInput value={caption} onChange={setCaption} onEnter={submitOnEnter} />
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
            onKeyDown={submitOnEnter}
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
              onKeyDown={submitOnEnter}
            />
          </div>
          <CaptionInput value={caption} onChange={setCaption} onEnter={submitOnEnter} />
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
              onKeyDown={submitOnEnter}
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
          <CaptionInput value={caption} onChange={setCaption} onEnter={submitOnEnter} />
        </>
      )}
    </div>
  );
}

function CaptionInput(props: {
  value: string;
  onChange: (v: string) => void;
  onEnter: (e: React.KeyboardEvent) => void;
}): React.ReactElement {
  return (
    <div style={s.row}>
      <label style={s.label}>Caption (optional)</label>
      <input
        style={s.input}
        placeholder="display text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={props.onEnter}
      />
    </div>
  );
}
