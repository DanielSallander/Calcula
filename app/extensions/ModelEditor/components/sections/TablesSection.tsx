// FILENAME: app/extensions/ModelEditor/components/sections/TablesSection.tsx
// PURPOSE: Tables section of the Model Editor window: master list of model
//          tables, per-table metadata form, and the columns grid with
//          physical-column editing plus calculated-column add/edit/delete.

import React, { useEffect, useState } from "react";
import {
  biModelDeleteCalcColumn,
  biModelDeleteTable,
  biModelRefreshTable,
  biModelSetTableRefresh,
  biModelSetTableSourceBinding,
  biModelSetTableStorageMode,
  biModelUpdateTable,
} from "@api";
import type {
  ModelColumnInfo,
  ModelOverview,
  ModelSourceInfo,
  ModelTableInfo,
  RefreshStrategyDto,
} from "@api";

const STORAGE_MODES = ["DirectQuery", "InMemory"];
const STRATEGY_TYPES = [
  { value: "interval", label: "Every N seconds" },
  { value: "containsCurrentDate", label: "Missing today's date" },
  { value: "dailyAfter", label: "Daily after time" },
  { value: "sourceQuery", label: "Source query changed" },
];
import { Badge, Field, SELECTION_BG, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { CalcColumnModal, PhysicalColumnModal } from "./TableColumnModals";
import { SqlEditorModal } from "../SqlEditorModal";

export function TablesSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const tables = overview.tables;

  const [selectedName, setSelectedName] = useState<string | null>(tables[0]?.name ?? null);
  const [physicalEdit, setPhysicalEdit] = useState<ModelColumnInfo | null>(null);
  const [calcEdit, setCalcEdit] = useState<{ existing: ModelColumnInfo | null } | null>(null);

  // Keep the selection valid when the table set changes (e.g. a table was just
  // deleted or imported) — the render-time "adjust state on prop change" pattern
  // rather than a useEffect.
  const selectionValid = selectedName !== null && tables.some((t) => t.name === selectedName);
  if (!selectionValid) {
    const next = tables[0]?.name ?? null;
    if (next !== selectedName) setSelectedName(next);
  }

  const table = tables.find((t) => t.name === selectedName) ?? null;

  const deleteCalcColumn = async (col: ModelColumnInfo) => {
    if (!window.confirm(`Delete calculated column '${col.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteCalcColumn(connectionId, col.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
      {/* Master: table list */}
      <div style={{ ...styles.card, width: 260, flexShrink: 0, overflowY: "auto", padding: 4 }}>
        {tables.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No tables in this model — import some under Import.
          </div>
        )}
        {tables.map((t) => (
          <div
            key={t.name}
            style={{
              ...styles.listRow,
              background: t.name === selectedName ? SELECTION_BG : undefined,
            }}
            onClick={() => setSelectedName(t.name)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <strong>{t.name}</strong>
              {t.isHidden && <Badge tone="warn">hidden</Badge>}
              <Badge tone={t.bound ? "ok" : "neutral"}>{t.bound ? "bound" : "unbound"}</Badge>
            </div>
            <div style={{ ...styles.muted, fontSize: 11 }}>
              {t.displayName ? `${t.displayName} · ` : ""}
              {t.storageMode} · {t.columns.length} columns
            </div>
          </div>
        ))}
      </div>

      {/* Detail */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        {!table && <div style={styles.muted}>Select a table.</div>}
        {table && (
          <>
            <TableMetaForm
              connectionId={connectionId}
              table={table}
              readOnly={readOnly}
              applyOverview={applyOverview}
              reportError={reportError}
            />

            {!table.sourceId && (
              <BindTableCard
                connectionId={connectionId}
                table={table}
                sources={overview.sources}
                readOnly={readOnly}
                applyOverview={applyOverview}
                reportError={reportError}
              />
            )}

            {table.storageMode === "InMemory" && (
              <RefreshStrategyCard
                connectionId={connectionId}
                table={table}
                readOnly={readOnly}
                applyOverview={applyOverview}
                reportError={reportError}
              />
            )}

            <div style={{ ...styles.sectionHeader, marginTop: 12, marginBottom: 8 }}>
              <span style={styles.sectionTitle}>Columns ({table.columns.length})</span>
              <button
                style={styles.btn}
                disabled={readOnly}
                onClick={() => setCalcEdit({ existing: null })}
              >
                Add calculated column
              </button>
            </div>
            <div style={{ ...styles.card, padding: 0, overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={styles.th}>Name</th>
                    <th style={styles.th}>Type</th>
                    <th style={styles.th}>Display name</th>
                    <th style={styles.th}>Description</th>
                    <th style={styles.th}>Hidden</th>
                    <th style={styles.th}>Formula</th>
                    <th style={styles.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {table.columns.map((c) => (
                    <tr key={c.name}>
                      <td style={styles.td}>
                        <strong>{c.name}</strong> {c.isCalculated && <Badge tone="ok">calc</Badge>}
                      </td>
                      <td style={styles.td}>{c.dataType}</td>
                      <td style={styles.td}>{c.displayName ?? ""}</td>
                      <td style={styles.td}>{c.description ?? ""}</td>
                      <td style={styles.td}>{c.isHidden ? "Yes" : ""}</td>
                      <td
                        style={{
                          ...styles.td,
                          fontFamily: "Consolas, 'Cascadia Code', monospace",
                          maxWidth: 240,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={c.formula ?? undefined}
                      >
                        {c.formula ?? ""}
                      </td>
                      <td style={{ ...styles.td, whiteSpace: "nowrap", textAlign: "right" }}>
                        {c.isCalculated ? (
                          <>
                            <button
                              style={styles.smallBtn}
                              disabled={readOnly}
                              onClick={() => setCalcEdit({ existing: c })}
                            >
                              Edit
                            </button>{" "}
                            <button
                              style={styles.smallBtn}
                              disabled={readOnly}
                              onClick={() => void deleteCalcColumn(c)}
                            >
                              Delete
                            </button>
                          </>
                        ) : (
                          <button
                            style={styles.smallBtn}
                            disabled={readOnly}
                            onClick={() => setPhysicalEdit(c)}
                          >
                            Edit
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {table && physicalEdit && (
        <PhysicalColumnModal
          connectionId={connectionId}
          table={table.name}
          column={physicalEdit}
          siblingColumns={table.columns.map((c) => c.name)}
          overview={overview}
          onClose={() => setPhysicalEdit(null)}
          onSaved={(o) => {
            applyOverview(o);
            setPhysicalEdit(null);
          }}
        />
      )}
      {table && calcEdit && (
        <CalcColumnModal
          connectionId={connectionId}
          table={table.name}
          existing={calcEdit.existing}
          onClose={() => setCalcEdit(null)}
          onSaved={(o) => {
            applyOverview(o);
            setCalcEdit(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Table metadata form (displayName / description / isHidden)
// ============================================================================

/** Shown for an unbound table: pick a catalog source + physical location to
 *  bind it (mirrors the Connections tab, kept here for convenience). */
function BindTableCard({
  connectionId,
  table,
  sources,
  readOnly,
  applyOverview,
  reportError,
}: {
  connectionId: string;
  table: ModelTableInfo;
  sources: ModelSourceInfo[];
  readOnly: boolean;
  applyOverview: (overview: ModelOverview) => void;
  reportError: (err: unknown) => void;
}): React.ReactElement {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  // Pre-filled from the chosen source's default schema (set on the connection),
  // so it isn't re-typed; follows the source dropdown, still editable.
  const [schema, setSchema] = useState(sources[0]?.defaultSchema ?? "public");
  const [sourceTable, setSourceTable] = useState(table.name);
  const [busy, setBusy] = useState(false);

  const bind = async () => {
    if (!sourceId || !sourceTable.trim()) return;
    setBusy(true);
    try {
      applyOverview(
        await biModelSetTableSourceBinding(
          connectionId,
          table.name,
          sourceId,
          schema.trim(),
          sourceTable.trim(),
        ),
      );
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{ ...styles.card, border: "1px solid #e2b04a", background: "#fdf6e3", marginTop: 8 }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Unbound table</div>
      {sources.length === 0 ? (
        <div style={styles.hint}>
          This table isn&apos;t bound to a data source. Add a source under the Connections tab, then
          bind it here.
        </div>
      ) : (
        <>
          <div style={{ ...styles.hint, marginBottom: 6 }}>
            Bind this table to a data source so it can be queried.
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select
              style={{ ...styles.input, fontSize: 12 }}
              value={sourceId}
              disabled={readOnly || busy}
              onChange={(e) => {
                setSourceId(e.target.value);
                const picked = sources.find((s) => s.id === e.target.value);
                setSchema(picked?.defaultSchema ?? "public");
              }}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName ?? s.id}
                </option>
              ))}
            </select>
            <input
              style={{ ...styles.input, fontSize: 12, width: 100 }}
              placeholder="schema"
              value={schema}
              disabled={readOnly || busy}
              onChange={(e) => setSchema(e.target.value)}
            />
            <input
              style={{ ...styles.input, fontSize: 12, width: 150 }}
              placeholder="source table"
              value={sourceTable}
              disabled={readOnly || busy}
              onChange={(e) => setSourceTable(e.target.value)}
            />
            <button
              style={styles.primaryBtn}
              disabled={readOnly || busy || !sourceId || !sourceTable.trim()}
              onClick={() => void bind()}
            >
              {busy ? "Binding…" : "Bind"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function TableMetaForm({
  connectionId,
  table,
  readOnly,
  applyOverview,
  reportError,
}: {
  connectionId: string;
  table: ModelTableInfo;
  readOnly: boolean;
  applyOverview: (overview: ModelOverview) => void;
  reportError: (err: unknown) => void;
}): React.ReactElement {
  const [displayName, setDisplayName] = useState(table.displayName ?? "");
  const [description, setDescription] = useState(table.description ?? "");
  const [isHidden, setIsHidden] = useState(table.isHidden);
  const [busy, setBusy] = useState(false);

  // Reseed the form when the selection (or a saved overview) changes.
  useEffect(() => {
    setDisplayName(table.displayName ?? "");
    setDescription(table.description ?? "");
    setIsHidden(table.isHidden);
  }, [table]);

  const save = async () => {
    setBusy(true);
    try {
      applyOverview(
        await biModelUpdateTable({
          connectionId,
          table: table.name,
          displayName: displayName.trim() || null,
          description: description.trim() || null,
          isHidden,
        }),
      );
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const changeStorageMode = async (mode: string) => {
    setBusy(true);
    try {
      applyOverview(await biModelSetTableStorageMode(connectionId, table.name, mode));
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const refreshData = async () => {
    setBusy(true);
    setRefreshMsg(null);
    try {
      await biModelRefreshTable(connectionId, table.name);
      setRefreshMsg("Cache dropped — next query re-fetches from source.");
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const deleteTable = async () => {
    if (
      !window.confirm(
        `Delete table '${table.name}' from the model? Any relationships that reference it are also removed.`,
      )
    )
      return;
    setBusy(true);
    try {
      applyOverview(await biModelDeleteTable(connectionId, table.name));
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{table.name}</span>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <span style={styles.muted}>Storage</span>
          <select
            style={{ ...styles.input, fontSize: 12 }}
            disabled={readOnly || busy}
            value={STORAGE_MODES.includes(table.storageMode) ? table.storageMode : ""}
            onChange={(e) => void changeStorageMode(e.target.value)}
          >
            {!STORAGE_MODES.includes(table.storageMode) && (
              <option value="">{table.storageMode}</option>
            )}
            {STORAGE_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <div style={{ flex: 1 }} />
        <button
          style={styles.smallBtn}
          disabled={readOnly || busy || !table.bound}
          title={
            table.bound
              ? "Drop the in-memory cache so the next query re-fetches from source"
              : "Bind the table to a live source first"
          }
          onClick={() => void refreshData()}
        >
          Refresh data
        </button>
        <button
          style={{ ...styles.smallBtn, color: "#a4262c" }}
          disabled={readOnly || busy}
          title="Remove this table from the model"
          onClick={() => void deleteTable()}
        >
          Delete table
        </button>
      </div>
      {refreshMsg && <div style={{ ...styles.hint, marginBottom: 6 }}>{refreshMsg}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Display name" flex={1}>
          <input
            style={styles.input}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={table.name}
          />
        </Field>
        <Field label="Description" flex={2}>
          <input
            style={styles.input}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={isHidden}
            onChange={(e) => setIsHidden(e.target.checked)}
          />
          Hidden
        </label>
        <div style={{ flex: 1 }} />
        <button style={styles.primaryBtn} disabled={readOnly || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save table"}
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Refresh-strategy editor (InMemory tables)
// ============================================================================
// The engine honors these lazily on each query (query_auto_refresh): a table
// whose cache a strategy marks stale is re-fetched from source before the
// query runs. Only meaningful for InMemory tables.

interface StrategyDraft {
  type: string;
  secs: string;
  column: string;
  hour: string;
  minute: string;
  sql: string;
  sourceTable: string;
}

function emptyStrategyDraft(): StrategyDraft {
  return {
    type: "interval",
    secs: "3600",
    column: "",
    hour: "6",
    minute: "0",
    sql: "",
    sourceTable: "",
  };
}

function strategyDtoToDraft(d: RefreshStrategyDto): StrategyDraft {
  return {
    type: d.type,
    secs: d.secs != null ? String(d.secs) : "3600",
    column: d.column ?? "",
    hour: d.hour != null ? String(d.hour) : "6",
    minute: d.minute != null ? String(d.minute) : "0",
    sql: d.sql ?? "",
    sourceTable: d.sourceTable ?? "",
  };
}

function strategyDraftToDto(s: StrategyDraft): RefreshStrategyDto {
  switch (s.type) {
    case "interval":
      return { type: "interval", secs: Number(s.secs) || 0 };
    case "containsCurrentDate":
      return { type: "containsCurrentDate", column: s.column };
    case "dailyAfter":
      return { type: "dailyAfter", hour: Number(s.hour) || 0, minute: Number(s.minute) || 0 };
    case "sourceQuery":
      return { type: "sourceQuery", sql: s.sql, sourceTable: s.sourceTable.trim() || null };
    default:
      return { type: s.type };
  }
}

function RefreshStrategyCard({
  connectionId,
  table,
  readOnly,
  applyOverview,
  reportError,
}: {
  connectionId: string;
  table: ModelTableInfo;
  readOnly: boolean;
  applyOverview: (overview: ModelOverview) => void;
  reportError: (err: unknown) => void;
}): React.ReactElement {
  const [drafts, setDrafts] = useState<StrategyDraft[]>(
    table.refreshStrategies.map(strategyDtoToDraft),
  );
  const [incr, setIncr] = useState(table.incrementalRefresh ?? "");
  const [busy, setBusy] = useState(false);
  const [sqlEditIndex, setSqlEditIndex] = useState<number | null>(null);

  // Re-seed when the selected table (or a saved overview) changes.
  useEffect(() => {
    setDrafts(table.refreshStrategies.map(strategyDtoToDraft));
    setIncr(table.incrementalRefresh ?? "");
  }, [table]);

  const update = (i: number, patch: Partial<StrategyDraft>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const columnsOf = table.columns.map((c) => c.name);

  const save = async () => {
    setBusy(true);
    try {
      applyOverview(
        await biModelSetTableRefresh({
          connectionId,
          tableName: table.name,
          strategies: drafts.map(strategyDraftToDto),
          incrementalRefresh: incr.trim() || null,
        }),
      );
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const disabled = readOnly || busy;

  return (
    <div style={{ ...styles.card, marginTop: 10 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Refresh strategies</div>
      <div style={{ ...styles.hint, marginBottom: 8 }}>
        Evaluated on each query — a table a strategy marks stale is re-fetched from source before
        the query runs. No strategy = cache once, reuse until manually refreshed.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {drafts.length === 0 && <div style={styles.hint}>No strategies.</div>}
        {drafts.map((s, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <select
              style={{ ...styles.input, width: 180, flexShrink: 0 }}
              value={s.type}
              onChange={(e) => update(i, { type: e.target.value })}
            >
              {STRATEGY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {s.type === "interval" && (
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                <input
                  style={{ ...styles.input, width: 90 }}
                  value={s.secs}
                  onChange={(e) => update(i, { secs: e.target.value })}
                />
                seconds
              </label>
            )}
            {s.type === "containsCurrentDate" && (
              <select
                style={{ ...styles.input, minWidth: 140 }}
                value={s.column}
                onChange={(e) => update(i, { column: e.target.value })}
              >
                <option value="">(date column)</option>
                {columnsOf.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            {s.type === "dailyAfter" && (
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                <input
                  style={{ ...styles.input, width: 50 }}
                  value={s.hour}
                  onChange={(e) => update(i, { hour: e.target.value })}
                />
                :
                <input
                  style={{ ...styles.input, width: 50 }}
                  value={s.minute}
                  onChange={(e) => update(i, { minute: e.target.value })}
                />
                (local)
              </label>
            )}
            {s.type === "sourceQuery" && (
              <button
                style={{
                  ...styles.input,
                  flex: 1,
                  minWidth: 160,
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "Consolas, monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: s.sql.trim() ? "#222" : "#999",
                }}
                title="Edit the source query"
                onClick={() => setSqlEditIndex(i)}
              >
                {s.sql.trim() ? s.sql.trim() : "Write the source query…"}
              </button>
            )}
            <button
              style={styles.smallBtn}
              onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            style={styles.smallBtn}
            onClick={() => setDrafts((ds) => [...ds, emptyStrategyDraft()])}
          >
            Add strategy
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <Field
          label="Incremental refresh filter (optional)"
          hint="DAX-like boolean over this table's columns identifying volatile rows to re-fetch (the rest of the cache is kept). e.g. date >= DATEADD(TODAY(), -7)"
        >
          <input style={styles.input} value={incr} onChange={(e) => setIncr(e.target.value)} />
        </Field>
      </div>

      <div>
        <button style={styles.primaryBtn} disabled={disabled} onClick={() => void save()}>
          {busy ? "Saving…" : "Save refresh strategies"}
        </button>
      </div>

      {sqlEditIndex !== null && (
        <SqlEditorModal
          title={`Source query — ${table.name}`}
          initialSql={drafts[sqlEditIndex]?.sql ?? ""}
          hint="Runs against the source; must return a single scalar (one row, one column). A changed value triggers a refresh. e.g. SELECT MAX(loaded_at) FROM etl_log WHERE table_name = 'products'"
          onClose={() => setSqlEditIndex(null)}
          onSave={(sql) => {
            update(sqlEditIndex, { sql });
            setSqlEditIndex(null);
          }}
        />
      )}
    </div>
  );
}
