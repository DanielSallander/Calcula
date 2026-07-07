// FILENAME: app/extensions/ModelEditor/components/sections/TableVariablesSection.tsx
// PURPOSE: Table Variables section of the Model Editor window: list named,
//          source-scoped filter sets (reusable in context KEEP / IN
//          operations) and add/edit/delete them. A variable's source can be a
//          model table OR another table variable, so variables can layer.

import React, { useState } from "react";
import { biModelDeleteTableVariable, biModelUpsertTableVariable } from "@api";
import type { ModelOverview, ModelTableVariableInfo } from "@api";
import {
  Field,
  FilterPredicateList,
  Modal,
  filterDraftToDto,
  filterDtoToDraft,
  isFilterDraftComplete,
  styles,
} from "../editorShared";
import type { FilterDraft, SectionCtx } from "../editorShared";

export function TableVariablesSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<{ original: ModelTableVariableInfo | null } | null>(null);

  const handleDelete = async (v: ModelTableVariableInfo) => {
    if (!window.confirm(`Delete table variable '${v.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteTableVariable(connectionId, v.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Table Variables ({overview.tableVariables.length})</span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.tableVariables.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No table variables defined — create one with New.
          </div>
        )}
        {overview.tableVariables.map((v) => (
          <div
            key={v.name}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{v.name}</strong>
              <span style={styles.muted}> — from {v.source}</span>
              <span style={styles.muted}>
                {" "}
                · {v.filters.length} filter{v.filters.length === 1 ? "" : "s"}
              </span>
            </div>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditing({ original: v })}>
              Edit
            </button>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => void handleDelete(v)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <TableVariableModal
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

function TableVariableModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelTableVariableInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [source, setSource] = useState(original?.source ?? "");
  const [filters, setFilters] = useState<FilterDraft[]>(
    original ? original.filters.map(filterDtoToDraft) : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A variable may be based on a model table OR on another table variable
  // (but not itself), so variables can layer.
  const sourceOptions = [
    ...overview.tables.map((t) => t.name),
    ...overview.tableVariables.filter((v) => v.name !== original?.name).map((v) => v.name),
  ];

  const canSave =
    name.trim() !== "" && source !== "" && filters.every(isFilterDraftComplete);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertTableVariable({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          source,
          filters: filters.map(filterDraftToDto),
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={original ? `Edit Table Variable: ${original.name}` : "New Table Variable"}
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
          placeholder="top_customers"
        />
      </Field>

      <Field label="Source" hint="A model table, or another table variable to layer on top of.">
        <select style={styles.input} value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">(select source)</option>
          {sourceOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>

      <div style={styles.field}>
        <label style={styles.label}>Filters</label>
        <FilterPredicateList
          overview={overview}
          filters={filters}
          onChange={setFilters}
          allowDynamic={false}
          addLabel="Add filter"
          emptyHint="No filters — the variable is the whole source table."
        />
      </div>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
