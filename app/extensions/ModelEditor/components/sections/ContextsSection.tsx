// FILENAME: app/extensions/ModelEditor/components/sections/ContextsSection.tsx
// PURPOSE: Contexts + Context Columns section of the Model Editor window.
//          Contexts are named, composable filter-operation lists (referenced by
//          measures via using(expr, context)); the operations editor bridges the
//          flat operation DTO to the engine's ContextOp enum. Context columns are
//          groupable, per-query columns computed from a scalar measure.

import React, { useState } from "react";
import {
  biModelDeleteContext,
  biModelDeleteContextColumn,
  biModelUpsertContext,
  biModelUpsertContextColumn,
} from "@api";
import type {
  ContextOpDto,
  ModelContextColumnInfo,
  ModelContextInfo,
  ModelOverview,
} from "@api";
import {
  Badge,
  emptyFilterDraft,
  Field,
  FilterPredicateList,
  filterDraftToDto,
  filterDtoToDraft,
  isFilterDraftComplete,
  Modal,
  styles,
} from "../editorShared";
import type { FilterDraft, SectionCtx } from "../editorShared";

// Data types offered by the context-column editor (mirrors the calc-column set;
// Decimal is excluded — it needs precision/scale not surfaced here).
const DATA_TYPES = ["String", "Int32", "Int64", "Float64", "Boolean", "Date", "Timestamp"];

const OP_TYPES = [
  { value: "keep", label: "Keep (add filters)" },
  { value: "keepIn", label: "Keep IN (membership)" },
  { value: "clear", label: "Clear (both sources)" },
  { value: "clearInner", label: "Clear inner (group-by)" },
  { value: "clearOuter", label: "Clear outer (query-level)" },
  { value: "reset", label: "Reset (all filters)" },
  { value: "resetInner", label: "Reset inner" },
  { value: "resetOuter", label: "Reset outer" },
  { value: "inherit", label: "Inherit context" },
  { value: "useRelationship", label: "Use relationship" },
];

const CLEAR_TYPES = new Set(["clear", "clearInner", "clearOuter"]);

// ============================================================================
// Section
// ============================================================================

export function ContextsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editingCtx, setEditingCtx] = useState<{ original: ModelContextInfo | null } | null>(null);
  const [editingCol, setEditingCol] = useState<{
    original: ModelContextColumnInfo | null;
  } | null>(null);

  const deleteContext = async (c: ModelContextInfo) => {
    if (!window.confirm(`Delete context '${c.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteContext(connectionId, c.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  const deleteColumn = async (c: ModelContextColumnInfo) => {
    if (!window.confirm(`Delete context column '${c.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteContextColumn(connectionId, c.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1, minHeight: 0, overflowY: "auto" }}>
      {/* Contexts */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>Contexts ({overview.contexts.length})</span>
          <button style={styles.btn} disabled={readOnly} onClick={() => setEditingCtx({ original: null })}>
            New
          </button>
        </div>
        <div style={{ ...styles.card, padding: 4 }}>
          {overview.contexts.length === 0 && (
            <div style={{ ...styles.muted, padding: 8 }}>
              No contexts defined — a context is a reusable set of filter operations applied via
              using(expr, context).
            </div>
          )}
          {overview.contexts.map((c) => (
            <div
              key={c.name}
              style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{c.name}</strong>
                <span style={styles.muted}>
                  {" "}
                  — {c.operations.length} operation{c.operations.length === 1 ? "" : "s"}
                </span>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
                  {c.operations.map((op, i) => (
                    <Badge key={i}>{op.type}</Badge>
                  ))}
                </div>
              </div>
              <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditingCtx({ original: c })}>
                Edit
              </button>
              <button style={styles.smallBtn} disabled={readOnly} onClick={() => void deleteContext(c)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Context columns */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>Context Columns ({overview.contextColumns.length})</span>
          <button style={styles.btn} disabled={readOnly} onClick={() => setEditingCol({ original: null })}>
            New
          </button>
        </div>
        <div style={{ ...styles.card, padding: 4 }}>
          {overview.contextColumns.length === 0 && (
            <div style={{ ...styles.muted, padding: 8 }}>
              No context columns — a groupable column whose per-row value derives from a scalar
              measure resolved against the query filters.
            </div>
          )}
          {overview.contextColumns.map((c) => (
            <div
              key={c.name}
              style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
              title={c.description ?? undefined}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{c.name}</strong>
                <span style={styles.muted}>
                  {" "}
                  — {c.table} · {c.dataType}
                </span>
                <div style={{ ...styles.muted, fontFamily: "Consolas, monospace", fontSize: 11 }}>
                  {c.expression}
                </div>
              </div>
              <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditingCol({ original: c })}>
                Edit
              </button>
              <button style={styles.smallBtn} disabled={readOnly} onClick={() => void deleteColumn(c)}>
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>

      {editingCtx && (
        <ContextModal
          connectionId={connectionId}
          overview={overview}
          original={editingCtx.original}
          onClose={() => setEditingCtx(null)}
          onSaved={(o) => {
            applyOverview(o);
            setEditingCtx(null);
          }}
        />
      )}
      {editingCol && (
        <ContextColumnModal
          connectionId={connectionId}
          overview={overview}
          original={editingCol.original}
          onClose={() => setEditingCol(null)}
          onSaved={(o) => {
            applyOverview(o);
            setEditingCol(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Context operation drafts (mirror ContextOpDto; only the relevant fields
// matter per `type`).
// ============================================================================

interface ClearTargetDraft {
  kind: string; // "column" | "table"
  table: string;
  column: string;
}

interface InPredicateDraft {
  table: string;
  column: string;
  varName: string;
  varColumn: string;
}

interface ContextOpDraft {
  type: string;
  filters: FilterDraft[];
  clearTargets: ClearTargetDraft[];
  inPredicates: InPredicateDraft[];
  inheritContext: string;
  relationshipName: string;
}

function emptyOpDraft(): ContextOpDraft {
  return {
    type: "keep",
    filters: [emptyFilterDraft()],
    clearTargets: [],
    inPredicates: [],
    inheritContext: "",
    relationshipName: "",
  };
}

function opDtoToDraft(op: ContextOpDto): ContextOpDraft {
  return {
    type: op.type,
    filters: (op.filters ?? []).map(filterDtoToDraft),
    clearTargets: (op.clearTargets ?? []).map((t) => ({
      kind: t.kind,
      table: t.table,
      column: t.column ?? "",
    })),
    inPredicates: (op.inPredicates ?? []).map((p) => ({
      table: p.table,
      column: p.column,
      varName: p.varName,
      varColumn: p.varColumn,
    })),
    inheritContext: op.inheritContext ?? "",
    relationshipName: op.relationshipName ?? "",
  };
}

function opDraftToDto(op: ContextOpDraft): ContextOpDto {
  return {
    type: op.type,
    filters: op.type === "keep" ? op.filters.map(filterDraftToDto) : [],
    clearTargets: CLEAR_TYPES.has(op.type)
      ? op.clearTargets.map((t) => ({
          kind: t.kind,
          table: t.table,
          column: t.kind === "column" ? t.column : null,
        }))
      : [],
    inPredicates:
      op.type === "keepIn"
        ? op.inPredicates.map((p) => ({
            table: p.table,
            column: p.column,
            varName: p.varName,
            varColumn: p.varColumn,
          }))
        : [],
    inheritContext: op.type === "inherit" ? op.inheritContext : null,
    relationshipName: op.type === "useRelationship" ? op.relationshipName : null,
  };
}

function isOpComplete(op: ContextOpDraft): boolean {
  switch (op.type) {
    case "keep":
      return op.filters.length > 0 && op.filters.every(isFilterDraftComplete);
    case "keepIn":
      return (
        op.inPredicates.length > 0 &&
        op.inPredicates.every(
          (p) => p.table && p.column && p.varName && p.varColumn.trim() !== "",
        )
      );
    case "clear":
    case "clearInner":
    case "clearOuter":
      return (
        op.clearTargets.length > 0 &&
        op.clearTargets.every((t) => t.table && (t.kind === "table" || t.column))
      );
    case "inherit":
      return op.inheritContext !== "";
    case "useRelationship":
      return op.relationshipName !== "";
    default:
      return true; // reset / resetInner / resetOuter
  }
}

// ============================================================================
// Context add/edit modal
// ============================================================================

function ContextModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelContextInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [ops, setOps] = useState<ContextOpDraft[]>(
    original && original.operations.length > 0
      ? original.operations.map(opDtoToDraft)
      : [emptyOpDraft()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columnsOf = (t: string): string[] =>
    overview.tables.find((x) => x.name === t)?.columns.map((c) => c.name) ?? [];

  const updateOp = (index: number, patch: Partial<ContextOpDraft>) =>
    setOps((os) => os.map((o, i) => (i === index ? { ...o, ...patch } : o)));

  const canSave = name.trim() !== "" && ops.length > 0 && ops.every(isOpComplete);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertContext({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          operations: ops.map(opDraftToDto),
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={original ? `Edit Context: ${original.name}` : "New Context"}
      width={820}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          style={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="bikes_2024"
        />
      </Field>

      <div style={styles.field}>
        <label style={styles.label}>Operations (applied in order)</label>
        {ops.map((op, i) => (
          <div
            key={i}
            style={{ border: "1px solid #e2e2e2", borderRadius: 4, padding: 8, marginBottom: 8 }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <select
                style={{ ...styles.input, flex: 1 }}
                value={op.type}
                onChange={(e) => updateOp(i, { type: e.target.value })}
              >
                {OP_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                style={styles.smallBtn}
                onClick={() => setOps((os) => os.filter((_, j) => j !== i))}
              >
                Remove op
              </button>
            </div>

            {op.type === "keep" && (
              <FilterPredicateList
                overview={overview}
                filters={op.filters}
                onChange={(filters) => updateOp(i, { filters })}
                allowDynamic
                emptyHint="No filters."
              />
            )}

            {op.type === "keepIn" && (
              <InPredicateEditor
                overview={overview}
                preds={op.inPredicates}
                onChange={(inPredicates) => updateOp(i, { inPredicates })}
              />
            )}

            {CLEAR_TYPES.has(op.type) && (
              <ClearTargetEditor
                overview={overview}
                targets={op.clearTargets}
                columnsOf={columnsOf}
                onChange={(clearTargets) => updateOp(i, { clearTargets })}
              />
            )}

            {op.type === "inherit" && (
              <select
                style={styles.input}
                value={op.inheritContext}
                onChange={(e) => updateOp(i, { inheritContext: e.target.value })}
              >
                <option value="">(context to inherit)</option>
                {overview.contexts
                  .filter((c) => c.name !== original?.name)
                  .map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
              </select>
            )}

            {op.type === "useRelationship" && (
              <select
                style={styles.input}
                value={op.relationshipName}
                onChange={(e) => updateOp(i, { relationshipName: e.target.value })}
              >
                <option value="">(relationship to activate)</option>
                {overview.relationships.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}

            {(op.type === "reset" || op.type === "resetInner" || op.type === "resetOuter") && (
              <div style={styles.hint}>Removes all filters for this scope — no operands.</div>
            )}
          </div>
        ))}
        <button style={styles.smallBtn} onClick={() => setOps((os) => [...os, emptyOpDraft()])}>
          Add operation
        </button>
      </div>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}

function ClearTargetEditor({
  overview,
  targets,
  columnsOf,
  onChange,
}: {
  overview: ModelOverview;
  targets: ClearTargetDraft[];
  columnsOf: (t: string) => string[];
  onChange: (targets: ClearTargetDraft[]) => void;
}): React.ReactElement {
  const update = (i: number, patch: Partial<ClearTargetDraft>) =>
    onChange(targets.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {targets.length === 0 && <div style={styles.hint}>No targets.</div>}
      {targets.map((t, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            style={{ ...styles.input, width: 90, flexShrink: 0 }}
            value={t.kind}
            onChange={(e) => update(i, { kind: e.target.value, column: "" })}
          >
            <option value="column">column</option>
            <option value="table">table</option>
          </select>
          <select
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={t.table}
            onChange={(e) => update(i, { table: e.target.value, column: "" })}
          >
            <option value="">(table)</option>
            {overview.tables.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </select>
          {t.kind === "column" && (
            <select
              style={{ ...styles.input, flex: 1, minWidth: 0 }}
              value={t.column}
              onChange={(e) => update(i, { column: e.target.value })}
            >
              <option value="">(column)</option>
              {columnsOf(t.table).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          <button style={styles.smallBtn} onClick={() => onChange(targets.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div>
        <button
          style={styles.smallBtn}
          onClick={() => onChange([...targets, { kind: "column", table: "", column: "" }])}
        >
          Add target
        </button>
      </div>
    </div>
  );
}

function InPredicateEditor({
  overview,
  preds,
  onChange,
}: {
  overview: ModelOverview;
  preds: InPredicateDraft[];
  onChange: (preds: InPredicateDraft[]) => void;
}): React.ReactElement {
  const columnsOf = (t: string): string[] =>
    overview.tables.find((x) => x.name === t)?.columns.map((c) => c.name) ?? [];
  const update = (i: number, patch: Partial<InPredicateDraft>) =>
    onChange(preds.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {preds.length === 0 && <div style={styles.hint}>No membership predicates.</div>}
      {preds.map((p, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <select
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={p.table}
            onChange={(e) => update(i, { table: e.target.value, column: "" })}
          >
            <option value="">(table)</option>
            {overview.tables.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name}
              </option>
            ))}
          </select>
          <select
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={p.column}
            onChange={(e) => update(i, { column: e.target.value })}
          >
            <option value="">(column)</option>
            {columnsOf(p.table).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <span style={styles.muted}>in</span>
          <select
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={p.varName}
            onChange={(e) => update(i, { varName: e.target.value })}
          >
            <option value="">(variable)</option>
            {overview.tableVariables.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={p.varColumn}
            onChange={(e) => update(i, { varColumn: e.target.value })}
            placeholder="var column"
          />
          <button style={styles.smallBtn} onClick={() => onChange(preds.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div>
        <button
          style={styles.smallBtn}
          onClick={() =>
            onChange([...preds, { table: "", column: "", varName: "", varColumn: "" }])
          }
        >
          Add membership
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Context column add/edit modal
// ============================================================================

function ContextColumnModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelContextColumnInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [table, setTable] = useState(original?.table ?? overview.tables[0]?.name ?? "");
  const [expression, setExpression] = useState(original?.expression ?? "");
  const [dataType, setDataType] = useState(original?.dataType ?? "String");
  const [description, setDescription] = useState(original?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && table !== "" && expression.trim() !== "";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertContextColumn({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          table,
          expression: expression.trim(),
          dataType,
          description: description.trim() || null,
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={original ? `Edit Context Column: ${original.name}` : "New Context Column"}
      width={620}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="PaymentStatus" />
      </Field>
      <Field label="Table">
        <select style={styles.input} value={table} onChange={(e) => setTable(e.target.value)}>
          {overview.tables.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Expression"
        hint='Row-level formula that may reference a scalar [Measure], e.g. IF(Invoice[paid_date] <= [AsOfDate], "Paid", "Open")'
      >
        <textarea
          style={{ ...styles.textarea, minHeight: 70 }}
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
        />
      </Field>
      <Field label="Data type">
        <select style={styles.input} value={dataType} onChange={(e) => setDataType(e.target.value)}>
          {DATA_TYPES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Description (optional)">
        <input style={styles.input} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
