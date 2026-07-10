// FILENAME: app/extensions/ModelEditor/components/sections/TestingGroundSection.tsx
// PURPOSE: Testing Ground section of the Model Editor window: an ad-hoc query
//          runner over the connection's model. Pick measures + group-by
//          dimensions + filters, optionally preview a security role (with
//          dynamic USERNAME()/CUSTOMDATA() identities), run, and inspect the
//          returned rows, per-column metadata, and (optionally) the execution
//          plan. Read-only — it never mutates the model.

import React, { useState } from "react";
import { biModelCancelQuery, biModelTestQuery, saveTextToFile } from "@api";
import type {
  MeasureFilterDto,
  PivotSortDto,
  RankByDto,
  TestQueryResult,
  TopNDto,
} from "@api";
import { Badge, Field, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { ExecutionPlanView } from "./ExecutionPlanView";

const FILTER_OPERATORS = ["=", "!=", ">", ">=", "<", "<="];

interface DimDraft {
  table: string;
  column: string;
}

interface FilterRow {
  table: string;
  column: string;
  operator: string;
  value: string;
}

interface SortRow {
  kind: string; // "measure" | "column"
  table: string;
  field: string;
  descending: boolean;
}

interface MeasureFilterRow {
  measure: string;
  operator: string;
  value: string;
}

function newQueryId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `q-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

export function TestingGroundSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview } = ctx;

  const [selectedMeasures, setSelectedMeasures] = useState<string[]>([]);
  const [rows, setRows] = useState<DimDraft[]>([]);
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [rowLimit, setRowLimit] = useState("100");
  const [rollup, setRollup] = useState(false);
  const [includePlan, setIncludePlan] = useState(false);

  const [sort, setSort] = useState<SortRow[]>([]);
  const [measureFilters, setMeasureFilters] = useState<MeasureFilterRow[]>([]);
  const [topN, setTopN] = useState<{ on: boolean; measure: string; limit: string; ascending: boolean }>(
    { on: false, measure: "", limit: "10", ascending: false },
  );
  const [rankBy, setRankBy] = useState<{ on: boolean; measure: string; ascending: boolean; dense: boolean }>(
    { on: false, measure: "", ascending: false, dense: false },
  );
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [previewRole, setPreviewRole] = useState("");
  const [previewUser, setPreviewUser] = useState("");
  const [previewCustom, setPreviewCustom] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestQueryResult | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const columnsOf = (t: string): string[] =>
    overview.tables.find((x) => x.name === t)?.columns.map((c) => c.name) ?? [];

  const toggleMeasure = (name: string) =>
    setSelectedMeasures((ms) =>
      ms.includes(name) ? ms.filter((m) => m !== name) : [...ms, name],
    );

  const canRun = selectedMeasures.length > 0 && !busy;

  const run = async () => {
    const qid = newQueryId();
    setBusy(true);
    setError(null);
    setRunningId(qid);
    const parsedLimit = parseInt(rowLimit, 10);
    const sortDtos: PivotSortDto[] = sort
      .filter((s) => s.field !== "")
      .map((s) => ({
        kind: s.kind,
        table: s.kind === "column" ? s.table : null,
        field: s.field,
        descending: s.descending,
      }));
    const mfDtos: MeasureFilterDto[] = measureFilters
      .filter((m) => m.measure !== "" && m.value.trim() !== "" && Number.isFinite(Number(m.value)))
      .map((m) => ({ measure: m.measure, operator: m.operator, value: Number(m.value) }));
    const topNDto: TopNDto | null =
      topN.on && topN.measure && Number(topN.limit) > 0
        ? { measure: topN.measure, limit: Number(topN.limit), ascending: topN.ascending }
        : null;
    const rankByDto: RankByDto | null =
      rankBy.on && rankBy.measure
        ? {
            measure: rankBy.measure,
            outputColumn: "Rank",
            dense: rankBy.dense,
            ascending: rankBy.ascending,
          }
        : null;
    try {
      const r = await biModelTestQuery({
        connectionId,
        measures: selectedMeasures,
        groupBy: rows.filter((d) => d.table && d.column),
        filters: filters
          .filter((f) => f.column && f.value.trim() !== "")
          .map((f) => ({ column: f.column, operator: f.operator, value: f.value })),
        sort: sortDtos,
        measureFilters: mfDtos,
        topN: topNDto,
        rankBy: rankByDto,
        rowLimit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null,
        rollup,
        includePlan,
        previewRole: previewRole || null,
        previewUserIdentity: previewUser.trim() || null,
        previewCustomData: previewCustom.trim() || null,
        queryId: qid,
      });
      setResult(r);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setBusy(false);
      setRunningId(null);
    }
  };

  const cancel = async () => {
    if (runningId) {
      try {
        await biModelCancelQuery(runningId);
      } catch {
        /* best-effort */
      }
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0, overflowY: "auto" }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Testing Ground</span>
        <button style={styles.primaryBtn} disabled={!canRun} onClick={() => void run()}>
          {busy ? "Running…" : "Run query"}
        </button>
        {busy && (
          <button style={styles.btn} onClick={() => void cancel()}>
            Cancel
          </button>
        )}
      </div>

      {/* Measures */}
      <div style={styles.card}>
        <label style={styles.label}>Measures</label>
        {overview.measures.length === 0 ? (
          <div style={styles.hint}>The model has no measures — add some in the Measures section.</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            {overview.measures.map((m) => (
              <label
                key={m.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 12,
                  border: "1px solid #ddd",
                  borderRadius: 3,
                  padding: "2px 6px",
                  cursor: "pointer",
                  background: selectedMeasures.includes(m.name) ? "#e8f0fd" : "#fff",
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedMeasures.includes(m.name)}
                  onChange={() => toggleMeasure(m.name)}
                />
                {m.name}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Group-by dimensions */}
      <div style={styles.card}>
        <label style={styles.label}>Group by (rows)</label>
        <DimensionList overview={overview} dims={rows} onChange={setRows} columnsOf={columnsOf} />
      </div>

      {/* Filters */}
      <div style={styles.card}>
        <label style={styles.label}>Filters</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
          {filters.length === 0 && <div style={styles.hint}>No filters.</div>}
          {filters.map((f, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select
                style={{ ...styles.input, flex: 1, minWidth: 0 }}
                value={f.table}
                onChange={(e) =>
                  setFilters((fs) =>
                    fs.map((x, j) => (j === i ? { ...x, table: e.target.value, column: "" } : x)),
                  )
                }
              >
                <option value="">(table)</option>
                {overview.tables.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
              <select
                style={{ ...styles.input, flex: 1, minWidth: 0 }}
                value={f.column}
                onChange={(e) =>
                  setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))
                }
              >
                <option value="">(column)</option>
                {columnsOf(f.table).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                style={{ ...styles.input, width: 54, flexShrink: 0 }}
                value={f.operator}
                onChange={(e) =>
                  setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, operator: e.target.value } : x)))
                }
              >
                {FILTER_OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <input
                style={{ ...styles.input, flex: 1, minWidth: 0 }}
                value={f.value}
                placeholder="value"
                onChange={(e) =>
                  setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                }
              />
              <button style={styles.smallBtn} onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <div>
            <button
              style={styles.smallBtn}
              onClick={() =>
                setFilters((fs) => [...fs, { table: "", column: "", operator: "=", value: "" }])
              }
            >
              Add filter
            </button>
          </div>
        </div>
      </div>

      {/* Options + RLS preview */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ ...styles.card, flex: 1, minWidth: 220 }}>
          <label style={styles.label}>Options</label>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 6 }}>
            <Field label="Row limit" flex={1}>
              <input
                style={styles.input}
                value={rowLimit}
                onChange={(e) => setRowLimit(e.target.value)}
                placeholder="100"
              />
            </Field>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 4 }}>
            <input type="checkbox" checked={rollup} onChange={(e) => setRollup(e.target.checked)} />
            Rollup subtotals
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 4 }}>
            <input type="checkbox" checked={includePlan} onChange={(e) => setIncludePlan(e.target.checked)} />
            Include execution plan
          </label>
        </div>

        <div style={{ ...styles.card, flex: 1, minWidth: 220 }}>
          <label style={styles.label}>Preview as role (RLS)</label>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
            <select style={styles.input} value={previewRole} onChange={(e) => setPreviewRole(e.target.value)}>
              <option value="">(no role — unrestricted)</option>
              {overview.securityRoles.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
            <input
              style={styles.input}
              value={previewUser}
              onChange={(e) => setPreviewUser(e.target.value)}
              placeholder="USERNAME() identity (optional)"
            />
            <input
              style={styles.input}
              value={previewCustom}
              onChange={(e) => setPreviewCustom(e.target.value)}
              placeholder="CUSTOMDATA() value (optional)"
            />
          </div>
        </div>
      </div>

      {/* Advanced: sort, HAVING, TOP-N, RANKX */}
      <div style={styles.card}>
        <button
          style={{ ...styles.smallBtn, border: "none", background: "transparent", padding: 0 }}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "▾" : "▸"} Advanced (sort, measure filters, top-N, ranking)
        </button>
        {showAdvanced && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
            {/* Sort */}
            <div>
              <label style={styles.label}>Sort</label>
              {sort.length === 0 && <div style={styles.hint}>No sort — default order.</div>}
              {sort.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                  <select
                    style={{ ...styles.input, width: 90 }}
                    value={s.kind}
                    onChange={(e) =>
                      setSort((ss) => ss.map((x, j) => (j === i ? { ...x, kind: e.target.value, field: "" } : x)))
                    }
                  >
                    <option value="measure">measure</option>
                    <option value="column">column</option>
                  </select>
                  {s.kind === "column" && (
                    <select
                      style={{ ...styles.input, flex: 1, minWidth: 0 }}
                      value={s.table}
                      onChange={(e) =>
                        setSort((ss) => ss.map((x, j) => (j === i ? { ...x, table: e.target.value, field: "" } : x)))
                      }
                    >
                      <option value="">(table)</option>
                      {overview.tables.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    style={{ ...styles.input, flex: 1, minWidth: 0 }}
                    value={s.field}
                    onChange={(e) => setSort((ss) => ss.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}
                  >
                    <option value="">({s.kind})</option>
                    {(s.kind === "measure"
                      ? selectedMeasures
                      : columnsOf(s.table)
                    ).map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={s.descending}
                      onChange={(e) =>
                        setSort((ss) => ss.map((x, j) => (j === i ? { ...x, descending: e.target.checked } : x)))
                      }
                    />
                    desc
                  </label>
                  <button style={styles.smallBtn} onClick={() => setSort((ss) => ss.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
              <button
                style={{ ...styles.smallBtn, marginTop: 4 }}
                onClick={() => setSort((ss) => [...ss, { kind: "measure", table: "", field: "", descending: true }])}
              >
                Add sort
              </button>
            </div>

            {/* Measure-value filters (HAVING) */}
            <div>
              <label style={styles.label}>Measure filters (HAVING)</label>
              {measureFilters.length === 0 && <div style={styles.hint}>No measure filters.</div>}
              {measureFilters.map((m, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                  <select
                    style={{ ...styles.input, flex: 1, minWidth: 0 }}
                    value={m.measure}
                    onChange={(e) =>
                      setMeasureFilters((ms) => ms.map((x, j) => (j === i ? { ...x, measure: e.target.value } : x)))
                    }
                  >
                    <option value="">(measure)</option>
                    {selectedMeasures.map((mm) => (
                      <option key={mm} value={mm}>
                        {mm}
                      </option>
                    ))}
                  </select>
                  <select
                    style={{ ...styles.input, width: 54, flexShrink: 0 }}
                    value={m.operator}
                    onChange={(e) =>
                      setMeasureFilters((ms) => ms.map((x, j) => (j === i ? { ...x, operator: e.target.value } : x)))
                    }
                  >
                    {FILTER_OPERATORS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                  <input
                    style={{ ...styles.input, width: 90, flexShrink: 0 }}
                    value={m.value}
                    placeholder="0"
                    onChange={(e) =>
                      setMeasureFilters((ms) => ms.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                    }
                  />
                  <button
                    style={styles.smallBtn}
                    onClick={() => setMeasureFilters((ms) => ms.filter((_, j) => j !== i))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                style={{ ...styles.smallBtn, marginTop: 4 }}
                onClick={() => setMeasureFilters((ms) => [...ms, { measure: "", operator: ">", value: "" }])}
              >
                Add measure filter
              </button>
              <div style={styles.hint}>Only selected measures can be filtered.</div>
            </div>

            {/* Top-N */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                <input type="checkbox" checked={topN.on} onChange={(e) => setTopN((t) => ({ ...t, on: e.target.checked }))} />
                Top-N by
              </label>
              <select
                style={{ ...styles.input, minWidth: 120 }}
                disabled={!topN.on}
                value={topN.measure}
                onChange={(e) => setTopN((t) => ({ ...t, measure: e.target.value }))}
              >
                <option value="">(measure)</option>
                {selectedMeasures.map((mm) => (
                  <option key={mm} value={mm}>
                    {mm}
                  </option>
                ))}
              </select>
              <input
                style={{ ...styles.input, width: 60 }}
                disabled={!topN.on}
                value={topN.limit}
                onChange={(e) => setTopN((t) => ({ ...t, limit: e.target.value }))}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                <input
                  type="checkbox"
                  disabled={!topN.on}
                  checked={topN.ascending}
                  onChange={(e) => setTopN((t) => ({ ...t, ascending: e.target.checked }))}
                />
                bottom
              </label>
            </div>

            {/* Ranking */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                <input type="checkbox" checked={rankBy.on} onChange={(e) => setRankBy((r) => ({ ...r, on: e.target.checked }))} />
                Add rank column by
              </label>
              <select
                style={{ ...styles.input, minWidth: 120 }}
                disabled={!rankBy.on}
                value={rankBy.measure}
                onChange={(e) => setRankBy((r) => ({ ...r, measure: e.target.value }))}
              >
                <option value="">(measure)</option>
                {selectedMeasures.map((mm) => (
                  <option key={mm} value={mm}>
                    {mm}
                  </option>
                ))}
              </select>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                <input
                  type="checkbox"
                  disabled={!rankBy.on}
                  checked={rankBy.dense}
                  onChange={(e) => setRankBy((r) => ({ ...r, dense: e.target.checked }))}
                />
                dense
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                <input
                  type="checkbox"
                  disabled={!rankBy.on}
                  checked={rankBy.ascending}
                  onChange={(e) => setRankBy((r) => ({ ...r, ascending: e.target.checked }))}
                />
                ascending
              </label>
            </div>
          </div>
        )}
      </div>

      {error && <div style={{ color: "red", fontSize: 12 }}>{error}</div>}

      {result && <ResultView result={result} />}
    </div>
  );
}

function DimensionList({
  overview,
  dims,
  onChange,
  columnsOf,
}: {
  overview: SectionCtx["overview"];
  dims: DimDraft[];
  onChange: (dims: DimDraft[]) => void;
  columnsOf: (t: string) => string[];
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
      {dims.length === 0 && <div style={styles.hint}>No dimensions — a single grand-total row is returned.</div>}
      {dims.map((d, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={d.table}
            onChange={(e) => onChange(dims.map((x, j) => (j === i ? { table: e.target.value, column: "" } : x)))}
          >
            <option value="">(table)</option>
            {overview.tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={d.column}
            onChange={(e) => onChange(dims.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}
          >
            <option value="">(column)</option>
            {columnsOf(d.table).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button style={styles.smallBtn} onClick={() => onChange(dims.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div>
        <button style={styles.smallBtn} onClick={() => onChange([...dims, { table: "", column: "" }])}>
          Add dimension
        </button>
      </div>
    </div>
  );
}

/** CSV-escape one cell (quote when it contains a comma, quote, or newline). */
function csvEscape(v: string): string {
  return v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v;
}

function ResultView({ result }: { result: TestQueryResult }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const cells = (): { headers: string[]; rows: string[][] } => ({
    headers: result.columns,
    rows: result.rows.map((r) => r.map((c) => c ?? "")),
  });
  const toCsv = (): string => {
    const { headers, rows } = cells();
    return [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join(
      "\n",
    );
  };
  const toTsv = (): string => {
    const { headers, rows } = cells();
    return [headers.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
  };

  const copyToClipboard = (): void => {
    void navigator.clipboard.writeText(toTsv());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  // BOM so Excel opens Swedish/accented characters correctly.
  const exportCsv = (): void => {
    void saveTextToFile({
      title: "Export Result as CSV",
      defaultName: "result.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
      content: toCsv(),
      encoding: "utf-8-bom",
    });
  };
  // Tab-separated .xls — Excel opens it natively (same trick as Studio).
  const exportExcel = (): void => {
    void saveTextToFile({
      title: "Export Result for Excel",
      defaultName: "result.xls",
      filters: [{ name: "Excel", extensions: ["xls"] }],
      content: toTsv(),
      encoding: "utf-8-bom",
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>
          Result ({result.rowCount} row{result.rowCount === 1 ? "" : "s"})
        </span>
        {result.truncated && <Badge tone="warn">truncated — more rows exist</Badge>}
        <span style={{ flex: 1 }} />
        <button style={styles.smallBtn} onClick={copyToClipboard}>
          {copied ? "Copied!" : "Copy"}
        </button>
        <button style={styles.smallBtn} onClick={exportCsv}>
          CSV…
        </button>
        <button style={styles.smallBtn} onClick={exportExcel}>
          Excel…
        </button>
      </div>
      {/* Fixed-height window over the rows (scrolls internally, sticky header)
          so the execution plan below stays within reach. */}
      <div style={{ ...styles.card, overflow: "auto", padding: 0, maxHeight: 320 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              {result.columns.map((c, i) => {
                const meta = result.resultColumns[i];
                return (
                  <th
                    key={i}
                    style={{ ...styles.th, position: "sticky", top: 0, background: "#f7f8fa", zIndex: 1 }}
                  >
                    {c}
                    {meta && (
                      <span style={{ ...styles.muted, fontWeight: 400, marginLeft: 4 }}>
                        {meta.kind === "Measure" ? "ƒ" : meta.kind === "Dimension" ? "◧" : ""}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 && (
              <tr>
                <td style={styles.td} colSpan={Math.max(1, result.columns.length)}>
                  <span style={styles.muted}>No rows.</span>
                </td>
              </tr>
            )}
            {result.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} style={styles.td}>
                    {cell === null ? <span style={styles.muted}>—</span> : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.plan && <ExecutionPlanView plan={result.plan} />}
    </div>
  );
}
