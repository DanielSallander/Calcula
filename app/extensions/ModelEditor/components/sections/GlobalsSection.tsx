// FILENAME: app/extensions/ModelEditor/components/sections/GlobalsSection.tsx
// PURPOSE: Calculated Tables section of the Model Editor window: list the
//          model's calculated tables (named QUERY(...) expressions evaluated
//          dynamically in the referencing query's filter context; "global
//          variables" in engine terms) and add/edit/delete them. The editor
//          mirrors the Measure editor: the shared ExpressionWorkspace with
//          Monaco front and centre. There is NO home-table picker — a
//          calculated table produces a new table, and the backend infers the
//          home table from the expression. Reusable scalars are hidden
//          measures, not calculated tables — see docs/design/calculated-tables.md.

import React, { useState } from "react";
import {
  biModelCalculatedTableDependents,
  biModelDeleteGlobalVariable,
  biModelMaterializeCalculatedTable,
  biModelUpsertGlobalVariable,
} from "@api";
import type { CalculatedTableDependents, ModelGlobalVariableInfo, ModelOverview } from "@api";
import { Badge, Field, Modal, SELECTION_BG, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { treeStyles } from "../treeKit";
import { ExpressionWorkspace } from "./ExpressionWorkspace";

/** Human-readable list of what is bound to a materialized calculated table
 *  (null when nothing is). Shown in the cascade-confirm dialogs. */
function dependentsSummary(d: CalculatedTableDependents): string | null {
  const lines: string[] = [];
  if (d.relationships.length > 0) lines.push(`Relationships: ${d.relationships.join(", ")}`);
  if (d.hierarchies.length > 0) lines.push(`Hierarchies: ${d.hierarchies.join(", ")}`);
  if (d.securityRoles.length > 0) lines.push(`Security-role filters in: ${d.securityRoles.join(", ")}`);
  if (d.tableVariables.length > 0) lines.push(`Table variables: ${d.tableVariables.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

export function GlobalsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ original: ModelGlobalVariableInfo | null } | null>(
    null,
  );

  const [materializing, setMaterializing] = useState<string | null>(null);

  const selectedGlobal = overview.globalVariables.find((g) => g.name === selected);

  const handleDelete = async (g: ModelGlobalVariableInfo) => {
    let cascade = false;
    if (!g.dynamic) {
      // Deleting a materialized calculated table removes its table from the
      // model — confirm with the list of everything bound to it.
      let summary: string | null = null;
      try {
        summary = dependentsSummary(await biModelCalculatedTableDependents(connectionId, g.name));
      } catch (err: unknown) {
        reportError(err);
        return;
      }
      const message = summary
        ? `Delete calculated table '${g.name}'?\n\nIts materialized table is removed from the model together with everything bound to it:\n\n${summary}`
        : `Delete calculated table '${g.name}'? (Its materialized table is removed from the model.)`;
      if (!window.confirm(message)) return;
      cascade = summary !== null;
    } else if (!window.confirm(`Delete calculated table '${g.name}'?`)) {
      return;
    }
    try {
      applyOverview(await biModelDeleteGlobalVariable(connectionId, g.name, cascade));
      if (selected === g.name) setSelected(null);
    } catch (err: unknown) {
      reportError(err);
    }
  };

  const handleMaterialize = async (g: ModelGlobalVariableInfo) => {
    setMaterializing(g.name);
    try {
      await biModelMaterializeCalculatedTable(connectionId, g.name);
    } catch (err: unknown) {
      reportError(err);
    } finally {
      setMaterializing(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>
          Calculated Tables ({overview.globalVariables.length})
        </span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
        <button
          style={styles.btn}
          disabled={readOnly || !selectedGlobal}
          onClick={() => selectedGlobal && setEditing({ original: selectedGlobal })}
        >
          Edit
        </button>
        <button
          style={styles.btn}
          disabled={readOnly || !selectedGlobal}
          onClick={() => selectedGlobal && void handleDelete(selectedGlobal)}
        >
          Delete
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.globalVariables.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No calculated tables defined — create one with New. (For a reusable
            scalar, define a hidden measure instead.)
          </div>
        )}
        {overview.globalVariables.map((g) => (
          <div
            key={g.name}
            style={{
              ...treeStyles.itemRow,
              background: g.name === selected ? SELECTION_BG : undefined,
            }}
            title={g.expression}
            onClick={() => setSelected(g.name)}
            onDoubleClick={() => {
              if (!readOnly) setEditing({ original: g });
            }}
          >
            <strong style={treeStyles.itemName}>{g.name}</strong>
            <Badge tone="neutral">{g.dynamic ? "dynamic" : "materialized"}</Badge>
            <span
              style={{
                ...styles.muted,
                fontFamily: "Consolas, 'Cascadia Code', monospace",
                fontSize: 12,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {g.expression}
            </span>
            {!g.dynamic && (
              <button
                style={styles.smallBtn}
                disabled={readOnly || materializing === g.name}
                title="Evaluate the QUERY now and refresh the materialized table's data"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleMaterialize(g);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {materializing === g.name ? "Materializing…" : "Materialize"}
              </button>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <CalculatedTableModal
          connectionId={connectionId}
          overview={overview}
          original={editing.original}
          onClose={() => setEditing(null)}
          onSaved={(o) => {
            applyOverview(o);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Add/edit modal — same workspace layout as the Measure editor
// ============================================================================

function CalculatedTableModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelGlobalVariableInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [expression, setExpression] = useState(original?.expression ?? "");
  const [dynamic, setDynamic] = useState(original?.dynamic ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCalendar = /^\s*calendar\s*\(/i.test(expression);
  const canSave = name.trim() !== "" && expression.trim() !== "";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // A materialized calculated table flipped to dynamic (or renamed) loses
      // its model table — confirm the destructive cascade first, listing
      // everything bound to the table that will be removed with it.
      // A CALENDAR is always materialized — the checkbox is ignored for it.
      let cascade = false;
      const staysMaterialized = !dynamic || isCalendar;
      const unmaterializes =
        original != null &&
        !original.dynamic &&
        (!staysMaterialized || name.trim() !== original.name);
      if (unmaterializes) {
        const summary = dependentsSummary(
          await biModelCalculatedTableDependents(connectionId, original.name),
        );
        if (summary) {
          const action = dynamic
            ? "Making it dynamic removes its table from the model"
            : "Renaming it replaces its table in the model";
          const ok = window.confirm(
            `'${original.name}' is materialized. ${action}, together with everything bound to the table:\n\n${summary}\n\nContinue?`,
          );
          if (!ok) {
            setBusy(false);
            return;
          }
          cascade = true;
        }
      }
      // No table is sent — the backend infers the home table from the
      // expression's first qualified column reference.
      const newOverview = await biModelUpsertGlobalVariable({
        connectionId,
        originalName: original?.name ?? null,
        name: name.trim(),
        expression: expression.trim(),
        dynamic,
        cascade,
      });
      // Populate the materialized table's data right away (refresh paths
      // also re-materialize automatically). A failure here does not undo the
      // model edit — surface it, then close normally.
      if (staysMaterialized) {
        try {
          await biModelMaterializeCalculatedTable(connectionId, name.trim());
        } catch (err: unknown) {
          window.alert(`Calculated table saved, but materializing its data failed:\n${String(err)}`);
        }
      }
      onSaved(newOverview);
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={original ? `Edit Calculated Table: ${original.name}` : "New Calculated Table"}
      width={1280}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? "Saving…" : "Save Calculated Table"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
        A calculated table is a named, table-producing QUERY(...) or CALENDAR(...) expression —
        it evaluates to a new table, referenced in measures as name[column]. (For a reusable
        scalar, define a hidden measure instead.)
      </div>

      {/* Identity row — Name plus the evaluation mode. */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Field label="Name" flex={1}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="city_sales"
          />
        </Field>
        <Field
          label="Evaluation"
          flex={2}
          hint={
            isCalendar
              ? "A CALENDAR table is always materialized."
              : dynamic
                ? "Evaluated per query in the live filter context (slicers apply). Usable inside measures only."
                : "Materialized at model refresh into a real table: appears under Tables, can have relationships and be a pivot source. Switching back to dynamic removes any relationships bound to it."
          }
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              padding: "4px 0",
              opacity: isCalendar ? 0.5 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={dynamic && !isCalendar}
              disabled={isCalendar}
              onChange={(e) => setDynamic(e.target.checked)}
            />
            Evaluate dynamically per query (uncheck to materialize at refresh)
          </label>
        </Field>
      </div>

      {/* Workspace: expression editor front-and-centre, same blades as measures. */}
      <ExpressionWorkspace
        overview={overview}
        value={expression}
        onChange={setExpression}
        label="Expression"
        hint="QUERY(SUM(fact[amount]) AS Amt BY dim[city]) — aggregate grouping; CALENDAR(2024-01-01, 2026-12-31) — generated date table. Drag from the tree to insert."
        hintTitle="QUERY(SUM(fact[amount]) AS Amt BY dim[city]) — aggregate grouping; QUERY(DISTINCT dim[city]) — unique rows (materialized only); CALENDAR(2024-01-01, 2026-12-31) — generated date table (materialized only). Referenced in measures as name[column]."
      />

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
