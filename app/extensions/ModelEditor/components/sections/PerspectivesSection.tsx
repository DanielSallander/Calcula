// FILENAME: app/extensions/ModelEditor/components/sections/PerspectivesSection.tsx
// PURPOSE: Perspectives section of the Model Editor window: list the model's
//          named presentation subsets (tables/columns/measures to show) and
//          add/edit/delete them. Presentation-only — NOT a security boundary
//          (use Security Roles' denied objects for access control).

import React, { useState } from "react";
import { biModelDeletePerspective, biModelUpsertPerspective } from "@api";
import type { ModelOverview, ModelPerspectiveInfo } from "@api";
import { Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

export function PerspectivesSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<{ original: ModelPerspectiveInfo | null } | null>(null);

  const handleDelete = async (p: ModelPerspectiveInfo) => {
    if (!window.confirm(`Delete perspective '${p.name}'?`)) return;
    try {
      applyOverview(await biModelDeletePerspective(connectionId, p.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Perspectives ({overview.perspectives.length})</span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.perspectives.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No perspectives defined — a perspective is a named subset of the model&apos;s tables,
            columns, and measures for a specific audience. Create one with New.
          </div>
        )}
        {overview.perspectives.map((p) => (
          <div
            key={p.name}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{p.name}</strong>
              <span style={styles.muted}>
                {" "}
                — {p.tables.length} table{p.tables.length === 1 ? "" : "s"}, {p.columns.length}{" "}
                column{p.columns.length === 1 ? "" : "s"}, {p.measures.length} measure
                {p.measures.length === 1 ? "" : "s"}
                {p.description ? ` · ${p.description}` : ""}
              </span>
            </div>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditing({ original: p })}>
              Edit
            </button>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => void handleDelete(p)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <PerspectiveModal
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

function PerspectiveModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelPerspectiveInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [description, setDescription] = useState(original?.description ?? "");
  const [tables, setTables] = useState<string[]>(original?.tables ?? []);
  const [measures, setMeasures] = useState<string[]>(original?.measures ?? []);
  const [columns, setColumns] = useState((original?.columns ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (list: string[], set: (v: string[]) => void, value: string) => {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertPerspective({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          tables,
          columns: columns
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          measures,
          description: description.trim() || null,
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  const checkList: React.CSSProperties = {
    maxHeight: 140,
    overflowY: "auto",
    border: "1px solid #ddd",
    borderRadius: 3,
    padding: 6,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  };

  return (
    <Modal
      title={original ? `Edit Perspective: ${original.name}` : "New Perspective"}
      width={720}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={styles.primaryBtn}
            disabled={busy || !name.trim()}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ ...styles.hint, marginBottom: 8 }}>
        A perspective names what to SHOW — everything unlisted is hidden from field lists when the
        perspective is selected. Presentation only: it is not a security boundary (use a Security
        Role&apos;s denied objects for that).
      </div>
      <Field label="Name">
        <input
          style={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sales view"
        />
      </Field>
      <Field label="Description (optional)">
        <input
          style={styles.input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <Field label="Tables (shown in full)">
        <div style={checkList}>
          {overview.tables.map((t) => (
            <label key={t.name} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={tables.includes(t.name)}
                onChange={() => toggle(tables, setTables, t.name)}
              />
              {t.name}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Measures">
        <div style={checkList}>
          {overview.measures.map((m) => (
            <label key={m.name} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={measures.includes(m.name)}
                onChange={() => toggle(measures, setMeasures, m.name)}
              />
              {m.name}
            </label>
          ))}
        </div>
      </Field>
      <Field
        label="Extra columns (optional)"
        hint="Individually shown columns from tables not listed in full — comma-separated Table[column] references."
      >
        <input
          style={styles.input}
          value={columns}
          onChange={(e) => setColumns(e.target.value)}
          placeholder="Customer[name], Product[category]"
        />
      </Field>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
