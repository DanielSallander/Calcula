// FILENAME: app/extensions/ModelEditor/components/sections/TablesSection.tsx
// PURPOSE: Tables section of the Model Editor window: master list of model
//          tables, per-table metadata form, and the columns grid with
//          physical-column editing plus calculated-column add/edit/delete.

import React, { useEffect, useRef, useState } from "react";
import {
  biModelDeleteCalcColumn,
  biModelDeleteContextColumn,
  biModelDeleteTable,
  biModelDeleteWritebackColumn,
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
  ModelWritebackColumnInfo,
  RefreshStrategyDto,
} from "@api";

const STORAGE_MODES = ["DirectQuery", "InMemory"];
const STRATEGY_TYPES = [
  { value: "interval", label: "Every N seconds" },
  { value: "containsCurrentDate", label: "Missing today's date" },
  { value: "dailyAfter", label: "Daily after time" },
  { value: "sourceQuery", label: "Source query changed" },
];
import { Badge, Field, SELECTION_BG, stripSchemaPrefix, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { Xref } from "../Xref";
import { ColumnSelectionBar } from "./ColumnSelectionBar";
import { CalcColumnModal, PhysicalColumnModal } from "./TableColumnModals";
import { WritebackColumnModal } from "./WritebackColumnModal";
import { SqlEditorModal } from "../SqlEditorModal";
import { TransformEditorModal, summarizeSteps } from "../transform";
import { confirmAsync } from "@api/dialogs";
import { ME } from "../theme";

export function TablesSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const tables = overview.tables;

  const [selectedName, setSelectedName] = useState<string | null>(tables[0]?.name ?? null);
  const [physicalEdit, setPhysicalEdit] = useState<ModelColumnInfo | null>(null);
  const [calcEdit, setCalcEdit] = useState<{ existing: ModelColumnInfo | null } | null>(null);
  const [writebackEdit, setWritebackEdit] = useState<{
    existing: ModelWritebackColumnInfo | null;
  } | null>(null);
  const [transformOpen, setTransformOpen] = useState(false);
  // Multi-select for bulk column edits. Keyed by column NAME, and cleared
  // whenever the selected table changes — a name from another table would
  // otherwise survive and be silently included in the next batch.
  const [selectedCols, setSelectedCols] = useState<string[]>([]);
  const lastClickedRow = useRef<number | null>(null);

  // Keep the selection valid when the table set changes (e.g. a table was just
  // deleted or imported) — the render-time "adjust state on prop change" pattern
  // rather than a useEffect.
  const selectionValid = selectedName !== null && tables.some((t) => t.name === selectedName);
  if (!selectionValid) {
    const next = tables[0]?.name ?? null;
    if (next !== selectedName) {
      setSelectedName(next);
      // The transform editor is per-table; it must never survive onto another.
      setTransformOpen(false);
      setSelectedCols([]);
    }
  }

  // Honour a route selection on ARRIVAL (the palette, an Xref, a restored
  // hash). Tracked by a ref so it applies once per requested name and then
  // stops fighting the user's own clicks — a route that re-asserted itself
  // every render would make the list unusable.
  const honouredSelection = useRef<string | null>(null);
  if (ctx.selection && ctx.selection !== honouredSelection.current) {
    honouredSelection.current = ctx.selection;
    if (tables.some((t) => t.name === ctx.selection) && ctx.selection !== selectedName) {
      setSelectedName(ctx.selection);
    }
  }

  // The column selection is by NAME, so switching tables must clear it or a
  // bulk edit would target names that happen to exist in the new table too.
  const shownTable = useRef<string | null>(selectedName);
  if (shownTable.current !== selectedName) {
    shownTable.current = selectedName;
    if (selectedCols.length > 0) setSelectedCols([]);
    lastClickedRow.current = null;
  }

  const table = tables.find((t) => t.name === selectedName) ?? null;

  /** Ctrl/plain click toggles one; shift-click extends from the last click. */
  const toggleColumn = (name: string, rowIndex: number, shift: boolean): void => {
    const all = allColumnNames.current;
    if (shift && lastClickedRow.current !== null) {
      const [lo, hi] =
        lastClickedRow.current <= rowIndex
          ? [lastClickedRow.current, rowIndex]
          : [rowIndex, lastClickedRow.current];
      const range = all.slice(lo, hi + 1);
      setSelectedCols((prev) => Array.from(new Set([...prev, ...range])));
      return;
    }
    lastClickedRow.current = rowIndex;
    setSelectedCols((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    );
  };
  // Writeback columns live on the MODEL (overview.writebackColumns), not in
  // the table's column list — pick out the selected table's here.
  const writebackCols = table
    ? overview.writebackColumns.filter((w) => w.table === table.name)
    : [];
  // Selectable = the columns a `set column` command can actually target.
  // Context (dynamic) columns are excluded: they are a projection of a context
  // expression, not physical columns, and `set column` does not own them.
  const selectableCols = table ? table.columns : [];
  const allColumnNames = useRef<string[]>([]);

  // Dynamic (context-driven) columns are shaped like column rows for the grid
  // but deliberately kept OUT of table.columns — pickers that require
  // materialized columns (sort-by, refresh date column, role filters,
  // relationships) must never see them.
  const dynamicCols: ModelColumnInfo[] = table
    ? overview.contextColumns
        .filter((c) => c.table === table.name)
        .map((c) => ({
          name: c.name,
          dataType: c.dataType,
          displayName: null,
          description: c.description,
          isHidden: false,
          isCalculated: true,
          isDynamic: true,
          formula: c.expression,
          lookupResolution: null,
          sortByColumn: null,
          formatString: null,
        }))
    : [];

  // Row order in the grid, so a shift-click range maps to the right names.
  // Written during render (this file's established pattern) because the grid
  // and the handler must agree on the SAME order, and the handler is created
  // before the rows are rendered.
  allColumnNames.current = table ? [...table.columns, ...dynamicCols].map((c) => c.name) : [];

  // Static and dynamic calculated columns live in different model stores —
  // the row's isDynamic flag routes the delete.
  const deleteCalcColumn = async (col: ModelColumnInfo) => {
    if (!(await confirmAsync(`Delete calculated column '${col.name}'?`))) return;
    try {
      applyOverview(
        col.isDynamic
          ? await biModelDeleteContextColumn(connectionId, col.name)
          : await biModelDeleteCalcColumn(connectionId, col.name),
      );
    } catch (err: unknown) {
      reportError(err);
    }
  };

  const deleteWritebackColumn = async (col: ModelWritebackColumnInfo) => {
    if (
      !(await confirmAsync(
        `Delete writeback column '${col.name}'? Its history/current store tables are removed from the model; collected entries stay in the workbook store.`,
      ))
    )
      return;
    try {
      applyOverview(await biModelDeleteWritebackColumn(connectionId, col.id));
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
            No tables in this model — <Xref to="import" navigate={ctx.navigate}>import some</Xref>.
          </div>
        )}
        {tables.map((t) => (
          <div
            key={t.name}
            style={{
              ...styles.listRow,
              background: t.name === selectedName ? SELECTION_BG : undefined,
            }}
            onClick={() => {
              setSelectedName(t.name);
              setTransformOpen(false);
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <strong>{t.name}</strong>
              {t.isHidden && <Badge tone="warn">hidden</Badge>}
              <Badge tone={t.bound ? "ok" : "neutral"}>{t.bound ? "bound" : "unbound"}</Badge>
              {t.transformSteps.length > 0 && (
                <Badge tone="ok">
                  {t.transformSteps.length} step{t.transformSteps.length === 1 ? "" : "s"}
                </Badge>
              )}
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
                navigate={ctx.navigate}
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

            <TransformCard table={table} onEdit={() => setTransformOpen(true)} />

            <div style={{ ...styles.sectionHeader, marginTop: 12, marginBottom: 8 }}>
              <span style={styles.sectionTitle}>
                Columns ({table.columns.length + dynamicCols.length + writebackCols.length})
              </span>
              <button
                style={styles.btn}
                disabled={readOnly}
                onClick={() => setCalcEdit({ existing: null })}
              >
                Add calculated column
              </button>
              <button
                style={styles.btn}
                disabled={readOnly}
                title="A typed input column end users fill in from pivots"
                onClick={() => setWritebackEdit({ existing: null })}
              >
                Add writeback column
              </button>
            </div>
            <ColumnSelectionBar
              ctx={ctx}
              table={table.name}
              selected={selectedCols}
              columns={selectableCols.map((c) => ({
                name: c.name,
                isHidden: c.isHidden,
                formatString: c.formatString,
                isCalculated: c.isCalculated,
              }))}
              onDone={() => setSelectedCols([])}
            />

            <div style={{ ...styles.card, padding: 0, overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ ...styles.th, width: 28 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all columns"
                        data-testid="select-all-columns"
                        ref={(el) => {
                          if (el) {
                            el.indeterminate =
                              selectedCols.length > 0 && selectedCols.length < selectableCols.length;
                          }
                        }}
                        checked={
                          selectableCols.length > 0 && selectedCols.length === selectableCols.length
                        }
                        onChange={(e) =>
                          setSelectedCols(e.target.checked ? selectableCols.map((c) => c.name) : [])
                        }
                      />
                    </th>
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
                  {[...table.columns, ...dynamicCols].map((c, rowIndex) => (
                    <tr
                      key={c.name}
                      data-me-row=""
                      style={
                        selectedCols.includes(c.name) ? { background: SELECTION_BG } : undefined
                      }
                    >
                      <td style={styles.td}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${c.name}`}
                          data-testid={`select-col-${c.name}`}
                          checked={selectedCols.includes(c.name)}
                          onChange={() => {}}
                          onClick={(e) => toggleColumn(c.name, rowIndex, e.shiftKey)}
                        />
                      </td>
                      <td style={styles.td}>
                        <strong>{c.name}</strong> {c.isCalculated && <Badge tone="ok">calc</Badge>}{" "}
                        {c.isDynamic && (
                          <Badge tone="neutral">dynamic</Badge>
                        )}
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
                  {writebackCols.map((w) => (
                    <tr key={`wb-${w.id}`}>
                      <td style={styles.td}>
                        <strong>{w.name}</strong> <Badge tone="warn">✎ writeback</Badge>{" "}
                        {w.kind === "masterData" && <Badge tone="neutral">master data</Badge>}
                      </td>
                      <td style={styles.td}>{w.dataType}</td>
                      <td style={{ ...styles.td, ...styles.muted }} colSpan={3}>
                        keys: {w.keyColumns.join(", ")}
                        {w.exposeHistory ? ` · history: ${w.historyTable}` : ""}
                      </td>
                      <td
                        style={{
                          ...styles.td,
                          fontFamily: "Consolas, 'Cascadia Code', monospace",
                          maxWidth: 240,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={
                          w.projectionMode === "expression"
                            ? (w.projectionExpression ?? undefined)
                            : w.projectionMode === "latest"
                              ? "Shows the latest submitted value"
                              : "Blank on reload — values are collected, not displayed"
                        }
                      >
                        {w.projectionMode === "expression"
                          ? (w.projectionExpression ?? "")
                          : w.projectionMode === "latest"
                            ? "(latest value)"
                            : "(blank on reload)"}
                      </td>
                      <td style={{ ...styles.td, whiteSpace: "nowrap", textAlign: "right" }}>
                        <button
                          style={styles.smallBtn}
                          disabled={readOnly}
                          onClick={() => setWritebackEdit({ existing: w })}
                        >
                          Edit
                        </button>{" "}
                        <button
                          style={styles.smallBtn}
                          disabled={readOnly}
                          onClick={() => void deleteWritebackColumn(w)}
                        >
                          Delete
                        </button>
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
      {table && writebackEdit && (
        <WritebackColumnModal
          connectionId={connectionId}
          table={table}
          existing={writebackEdit.existing}
          overview={overview}
          onClose={() => setWritebackEdit(null)}
          onSaved={(o) => {
            applyOverview(o);
            setWritebackEdit(null);
          }}
        />
      )}
      {table && transformOpen && (
        <TransformEditorModal
          connectionId={connectionId}
          table={table}
          overview={overview}
          readOnly={readOnly}
          onClose={() => setTransformOpen(false)}
          onApplied={applyOverview}
        />
      )}
    </div>
  );
}

// ============================================================================
// Transformation pipeline card ("applied steps")
// ============================================================================
// A summary and a door. The pipeline itself is edited in a modal because it is
// per-table state with its own draft, preview and single commit — see
// components/transform/.

function TransformCard({
  table,
  onEdit,
}: {
  table: ModelTableInfo;
  onEdit: () => void;
}): React.ReactElement {
  // The pipeline lives on the table's SOURCE BINDING, which `sourceId` reports
  // exactly; `bound` is looser (a live app binding counts) and would offer the
  // editor to tables that cannot carry steps.
  const canCarrySteps = table.sourceId !== null;
  return (
    <div style={{ ...styles.card, marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, flex: 1 }}>Transformations</span>
        {table.transformSteps.length > 0 && (
          <Badge tone="ok">
            {table.transformSteps.length} step{table.transformSteps.length === 1 ? "" : "s"}
          </Badge>
        )}
        <button
          style={styles.btn}
          disabled={!canCarrySteps}
          title={
            canCarrySteps
              ? "Shape the rows the source returns before the model sees them"
              : "Bind this table to a data source first — steps transform what a connector returns"
          }
          onClick={onEdit}
        >
          Edit transforms&hellip;
        </button>
      </div>
      <div style={{ ...styles.hint, marginBottom: table.transformSteps.length > 0 ? 6 : 0 }}>
        {canCarrySteps
          ? summarizeSteps(table.transformSteps)
          : "Unbound tables have nothing to transform."}
      </div>
      {table.transformSteps.length > 0 && (
        <div style={styles.hint}>
          Re-evaluated from scratch on every refresh. A transformed table is loaded in memory, so it
          cannot use DirectQuery.
        </div>
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
  navigate,
}: {
  connectionId: string;
  table: ModelTableInfo;
  sources: ModelSourceInfo[];
  readOnly: boolean;
  applyOverview: (overview: ModelOverview) => void;
  reportError: (err: unknown) => void;
  navigate: SectionCtx["navigate"];
}): React.ReactElement {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  // Pre-filled from the chosen source's default schema (set on the connection),
  // so it isn't re-typed; follows the source dropdown, still editable.
  const [schema, setSchema] = useState(sources[0]?.defaultSchema ?? "public");
  // The remote table guess is the model name MINUS its schema prefix — model
  // tables imported from a schema are named "<schema>.<table>", but the binding
  // wants the bare remote name (the query engine adds the schema itself).
  const [sourceTable, setSourceTable] = useState(
    stripSchemaPrefix(table.name, sources[0]?.defaultSchema ?? ""),
  );
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
      style={{ ...styles.card, border: `1px solid ${ME.warnBorder}`, background: ME.warnBg, marginTop: 8 }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Unbound table</div>
      {sources.length === 0 ? (
        <div style={styles.hint}>
          This table isn&apos;t bound to a data source.{" "}
          <Xref to="connections" navigate={navigate}>
            Add a source
          </Xref>
          , then bind it here.
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

  // A pipeline forces the table in-memory: the steps run over the rows the
  // source returned, which DirectQuery never materializes.
  const transformed = table.transformSteps.length > 0;

  const deleteTable = async () => {
    if (
      !(await confirmAsync(
        `Delete table '${table.name}' from the model? Any relationships that reference it are also removed.`,
      ))
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
            title={
              transformed
                ? "This table has transformation steps. The steps run over the rows the source returns, so a transformed table is loaded in memory — DirectQuery is unavailable until the steps are cleared."
                : undefined
            }
            value={STORAGE_MODES.includes(table.storageMode) ? table.storageMode : ""}
            onChange={(e) => void changeStorageMode(e.target.value)}
          >
            {!STORAGE_MODES.includes(table.storageMode) && (
              <option value="">{table.storageMode}</option>
            )}
            {STORAGE_MODES.map((m) => (
              <option key={m} value={m} disabled={transformed && m === "DirectQuery"}>
                {m}
                {transformed && m === "DirectQuery" ? " (not for transformed tables)" : ""}
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
          style={{ ...styles.smallBtn, color: ME.dangerFg }}
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
                  color: s.sql.trim() ? ME.text : ME.text3,
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
