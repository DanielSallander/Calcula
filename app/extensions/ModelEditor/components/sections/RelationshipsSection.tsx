// FILENAME: app/extensions/ModelEditor/components/sections/RelationshipsSection.tsx
// PURPOSE: Relationships section of the Model Editor window: list model
//          relationships and add/edit/delete them (multi-condition joins,
//          cardinality, active flag).

import React, { useState } from "react";
import { biModelDeleteRelationship, biModelUpsertRelationship } from "@api";
import type {
  ModelOverview,
  ModelRelationshipInfo,
  RelationshipConditionDto,
} from "@api";
import { Badge, Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { RelationshipDiagram } from "../diagram/RelationshipDiagram";
import type { ColumnDropResult } from "../diagram/RelationshipDiagram";

const CARDINALITIES = ["manyToOne", "oneToMany", "oneToOne", "manyToMany"];
const JOIN_OPERATORS = ["=", ">", ">=", "<", "<="];
const PROPAGATIONS = [
  { value: "auto", label: "Auto (to → from)" },
  { value: "none", label: "None (explicit traverse)" },
  { value: "both", label: "Both (bidirectional)" },
];

type EditState = {
  original: ModelRelationshipInfo | null;
  prefill?: ColumnDropResult;
};

export function RelationshipsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<EditState | null>(null);
  const [view, setView] = useState<"list" | "diagram">("list");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const handleDelete = async (r: ModelRelationshipInfo) => {
    if (!window.confirm(`Delete relationship '${r.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteRelationship(connectionId, r.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  const openEdit = (name: string) => {
    const rel = overview.relationships.find((r) => r.name === name);
    if (rel) setEditing({ original: rel });
  };

  const viewToggle = (
    <div style={{ display: "flex", gap: 0, border: `1px solid #bbb`, borderRadius: 3, overflow: "hidden" }}>
      {(["list", "diagram"] as const).map((v) => (
        <button
          key={v}
          style={{
            ...styles.smallBtn,
            border: "none",
            borderRadius: 0,
            background: view === v ? "#2f6fce" : "#fff",
            color: view === v ? "#fff" : "#222",
          }}
          onClick={() => setView(v)}
        >
          {v === "list" ? "List" : "Diagram"}
        </button>
      ))}
    </div>
  );

  const modal = editing && (
    <RelationshipModal
      connectionId={connectionId}
      overview={overview}
      original={editing.original}
      prefill={editing.prefill}
      onClose={() => setEditing(null)}
      onSaved={(o) => {
        applyOverview(o);
        setEditing(null);
      }}
    />
  );

  if (view === "diagram") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>Relationships ({overview.relationships.length})</span>
          {viewToggle}
          <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
            New
          </button>
        </div>
        <div style={{ ...styles.card, flex: 1, minHeight: 0, padding: 0, overflow: "auto" }}>
          <RelationshipDiagram
            tables={overview.tables}
            relationships={overview.relationships}
            selectedTable={selectedTable}
            onSelectTable={setSelectedTable}
            onEditRelationship={openEdit}
            onColumnDrop={
              readOnly
                ? undefined
                : (r) => setEditing({ original: null, prefill: r })
            }
            layoutKey={connectionId}
          />
        </div>
        <div style={styles.hint}>
          Drag a column onto another table&apos;s column to create a relationship; double-click an
          edge to edit it. Node positions are saved locally per connection.
        </div>
        {modal}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>
          Relationships ({overview.relationships.length})
        </span>
        {viewToggle}
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.relationships.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No relationships defined — create one with New.
          </div>
        )}
        {overview.relationships.map((r) => (
          <div
            key={r.name}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <strong>{r.name}</strong>
                <Badge>{r.cardinality}</Badge>
                {!r.active && <Badge tone="warn">inactive</Badge>}
              </div>
              <div
                style={{
                  ...styles.muted,
                  fontSize: 12,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.conditions.some((c) => (c.operator ?? "=") !== "=") ? (
                  // Non-equi join: spell out each condition with its operator.
                  <>
                    {r.fromTable} {"->"} {r.toTable} on{" "}
                    {r.conditions
                      .map((c) => `${c.fromColumn} ${c.operator ?? "="} ${c.toColumn}`)
                      .join(", ")}
                  </>
                ) : (
                  <>
                    {r.fromTable}[{r.conditions.map((c) => c.fromColumn).join(", ")}]
                    {" -> "}
                    {r.toTable}[{r.conditions.map((c) => c.toColumn).join(", ")}]
                  </>
                )}
              </div>
            </div>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditing({ original: r })}>
              Edit
            </button>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => void handleDelete(r)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {modal}
    </div>
  );
}

// ============================================================================
// Add/edit modal
// ============================================================================

function RelationshipModal({
  connectionId,
  overview,
  original,
  prefill,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelRelationshipInfo | null;
  /** Seed a brand-new relationship from a diagram column-drop. */
  prefill?: ColumnDropResult;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(
    original?.name ?? (prefill ? `${prefill.fromTable}_to_${prefill.toTable}` : ""),
  );
  const [fromTable, setFromTable] = useState(original?.fromTable ?? prefill?.fromTable ?? "");
  const [toTable, setToTable] = useState(original?.toTable ?? prefill?.toTable ?? "");
  // Seed operator explicitly so existing non-equi joins round-trip through
  // the edit modal instead of being coerced back to equality on save.
  const [conditions, setConditions] = useState<RelationshipConditionDto[]>(
    original && original.conditions.length > 0
      ? original.conditions.map((c) => ({
          fromColumn: c.fromColumn,
          toColumn: c.toColumn,
          operator: c.operator ?? "=",
        }))
      : prefill
        ? [{ fromColumn: prefill.fromColumn, toColumn: prefill.toColumn, operator: "=" }]
        : [{ fromColumn: "", toColumn: "", operator: "=" }],
  );
  const [cardinality, setCardinality] = useState(original?.cardinality ?? "manyToOne");
  const [active, setActive] = useState(original?.active ?? true);
  const [filterPropagation, setFilterPropagation] = useState(
    original?.filterPropagation ?? "auto",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columnsOf = (tableName: string): string[] =>
    overview.tables.find((t) => t.name === tableName)?.columns.map((c) => c.name) ?? [];
  const fromCols = columnsOf(fromTable);
  const toCols = columnsOf(toTable);

  const updateCondition = (index: number, patch: Partial<RelationshipConditionDto>) => {
    setConditions((cs) => cs.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const canSave =
    name.trim() !== "" &&
    fromTable !== "" &&
    toTable !== "" &&
    conditions.length > 0 &&
    conditions.every((c) => c.fromColumn !== "" && c.toColumn !== "");

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertRelationship({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          fromTable,
          toTable,
          conditions,
          cardinality,
          active,
          filterPropagation,
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  const tableSelect = (
    value: string,
    onChange: (v: string) => void,
    side: "fromColumn" | "toColumn",
  ) => (
    <select
      style={styles.input}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        // The old columns no longer apply — clear this side of every condition.
        setConditions((cs) => cs.map((c) => ({ ...c, [side]: "" })));
      }}
    >
      <option value="">(select table)</option>
      {overview.tables.map((t) => (
        <option key={t.name} value={t.name}>
          {t.name}
        </option>
      ))}
    </select>
  );

  return (
    <Modal
      title={original ? `Edit Relationship: ${original.name}` : "New Relationship"}
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
        <input
          style={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sales_to_Date"
        />
      </Field>
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="From table (many side)" flex={1}>
          {tableSelect(fromTable, setFromTable, "fromColumn")}
        </Field>
        <Field label="To table (one side)" flex={1}>
          {tableSelect(toTable, setToTable, "toColumn")}
        </Field>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>Join conditions</label>
        {conditions.map((c, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select
              style={{ ...styles.input, flex: 1 }}
              value={c.fromColumn}
              onChange={(e) => updateCondition(i, { fromColumn: e.target.value })}
            >
              <option value="">(from column)</option>
              {fromCols.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              style={{ ...styles.input, width: 54, flexShrink: 0 }}
              value={c.operator ?? "="}
              onChange={(e) => updateCondition(i, { operator: e.target.value })}
            >
              {JOIN_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <select
              style={{ ...styles.input, flex: 1 }}
              value={c.toColumn}
              onChange={(e) => updateCondition(i, { toColumn: e.target.value })}
            >
              <option value="">(to column)</option>
              {toCols.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button
              style={styles.smallBtn}
              disabled={conditions.length === 1}
              onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            style={styles.smallBtn}
            onClick={() =>
              setConditions((cs) => [...cs, { fromColumn: "", toColumn: "", operator: "=" }])
            }
          >
            Add condition
          </button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <Field label="Cardinality" flex={1}>
          <select
            style={styles.input}
            value={cardinality}
            onChange={(e) => setCardinality(e.target.value)}
          >
            {CARDINALITIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Filter propagation" flex={1}>
          <select
            style={styles.input}
            value={filterPropagation}
            onChange={(e) => setFilterPropagation(e.target.value)}
          >
            {PROPAGATIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 12 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
      </div>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
