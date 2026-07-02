// FILENAME: app/extensions/ModelEditor/components/sections/RolesSection.tsx
// PURPOSE: Security roles section of the Model Editor window: list RLS roles
//          and add/edit/delete them (per-filter table/column/operator/value,
//          with USERNAME()/CUSTOMDATA() dynamic filters).

import React, { useState } from "react";
import { biModelDeleteRole, biModelUpsertRole } from "@api";
import type { ModelOverview, ModelRoleInfo } from "@api";
import { Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

const OPERATORS = ["=", "!=", ">", ">=", "<", "<="];

const DYNAMIC_OPTIONS = [
  { value: "", label: "None" },
  { value: "username", label: "USERNAME()" },
  { value: "customData", label: "CUSTOMDATA()" },
];

export function RolesSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<{ original: ModelRoleInfo | null } | null>(null);

  const handleDelete = async (r: ModelRoleInfo) => {
    if (!window.confirm(`Delete security role '${r.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteRole(connectionId, r.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Security Roles ({overview.securityRoles.length})</span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.securityRoles.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No security roles defined — create one with New.
          </div>
        )}
        {overview.securityRoles.map((r) => (
          <div
            key={r.name}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{r.name}</strong>
              <span style={styles.muted}>
                {" "}
                — {r.filters.length} filter{r.filters.length === 1 ? "" : "s"}
              </span>
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

      {editing && (
        <RoleModal
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
// Add/edit modal
// ============================================================================

interface FilterDraft {
  table: string;
  column: string;
  operator: string;
  value: string;
  /** "" = static; "username" | "customData" = dynamic RLS. */
  dynamic: string;
}

function RoleModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelRoleInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [filters, setFilters] = useState<FilterDraft[]>(
    original && original.filters.length > 0
      ? original.filters.map((f) => ({
          table: f.table,
          column: f.column,
          operator: f.operator,
          value: f.value,
          dynamic: f.dynamic ?? "",
        }))
      : [{ table: "", column: "", operator: "=", value: "", dynamic: "" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columnsOf = (tableName: string): string[] =>
    overview.tables.find((t) => t.name === tableName)?.columns.map((c) => c.name) ?? [];

  const updateFilter = (index: number, patch: Partial<FilterDraft>) => {
    setFilters((fs) => fs.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };

  const canSave =
    name.trim() !== "" &&
    filters.every(
      (f) =>
        f.table !== "" &&
        f.column !== "" &&
        (f.dynamic !== "" || f.value.trim() !== ""),
    );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertRole({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          filters: filters.map((f) => ({
            table: f.table,
            column: f.column,
            operator: f.operator,
            value: f.dynamic !== "" ? "" : f.value,
            dynamic: f.dynamic === "" ? null : f.dynamic,
          })),
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={original ? `Edit Role: ${original.name}` : "New Role"}
      width={760}
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
          placeholder="Regional Managers"
        />
      </Field>

      <div style={styles.field}>
        <label style={styles.label}>Row filters</label>
        {filters.length === 0 && (
          <div style={styles.hint}>No filters — this role does not restrict any rows.</div>
        )}
        {filters.map((f, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select
              style={{ ...styles.input, flex: 2, minWidth: 0 }}
              value={f.table}
              onChange={(e) => updateFilter(i, { table: e.target.value, column: "" })}
            >
              <option value="">(table)</option>
              {overview.tables.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              style={{ ...styles.input, flex: 2, minWidth: 0 }}
              value={f.column}
              onChange={(e) => updateFilter(i, { column: e.target.value })}
            >
              <option value="">(column)</option>
              {columnsOf(f.table).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              style={{ ...styles.input, width: 58, flexShrink: 0 }}
              value={f.operator}
              onChange={(e) => updateFilter(i, { operator: e.target.value })}
            >
              {OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <input
              style={{ ...styles.input, flex: 2, minWidth: 0 }}
              value={f.value}
              disabled={f.dynamic !== ""}
              onChange={(e) => updateFilter(i, { value: e.target.value })}
              placeholder={f.dynamic !== "" ? "(dynamic)" : "Value"}
            />
            <select
              style={{ ...styles.input, flex: 2, minWidth: 0 }}
              value={f.dynamic}
              onChange={(e) => updateFilter(i, { dynamic: e.target.value })}
            >
              {DYNAMIC_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
            <button
              style={styles.smallBtn}
              onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            style={styles.smallBtn}
            onClick={() =>
              setFilters((fs) => [
                ...fs,
                { table: "", column: "", operator: "=", value: "", dynamic: "" },
              ])
            }
          >
            Add filter
          </button>
        </div>
        <div style={styles.hint}>
          Dynamic filters compare the column against the connecting user
          (USERNAME()) or their custom data (CUSTOMDATA()) instead of a fixed value.
        </div>
      </div>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
