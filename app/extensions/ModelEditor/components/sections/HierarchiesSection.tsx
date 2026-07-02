// FILENAME: app/extensions/ModelEditor/components/sections/HierarchiesSection.tsx
// PURPOSE: Hierarchies section of the Model Editor window: list model
//          hierarchies and add/edit/delete them (table + ordered levels with
//          optional display names).

import React, { useState } from "react";
import { biModelDeleteHierarchy, biModelUpsertHierarchy } from "@api";
import type { ModelHierarchyInfo, ModelOverview } from "@api";
import { Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

export function HierarchiesSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<{ original: ModelHierarchyInfo | null } | null>(null);

  const handleDelete = async (h: ModelHierarchyInfo) => {
    if (!window.confirm(`Delete hierarchy '${h.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteHierarchy(connectionId, h.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>Hierarchies ({overview.hierarchies.length})</span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.hierarchies.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No hierarchies defined — create one with New.
          </div>
        )}
        {overview.hierarchies.map((h) => (
          <div
            key={h.name}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <strong>{h.name}</strong>
                <span style={styles.muted}> — {h.table}</span>
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
                {h.levels.map((l) => l.displayName ?? l.column).join(" > ")}
              </div>
            </div>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditing({ original: h })}>
              Edit
            </button>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => void handleDelete(h)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <HierarchyModal
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

interface LevelDraft {
  column: string;
  displayName: string;
  /** Ragged-hierarchy flag — editable via the "optional" checkbox. */
  isOptional: boolean;
  /** Ragged-hierarchy stopper — no UI; round-tripped so it never drops. */
  stopperValue: string | null;
}

function HierarchyModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelHierarchyInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [table, setTable] = useState(original?.table ?? "");
  const [levels, setLevels] = useState<LevelDraft[]>(
    original && original.levels.length > 0
      ? original.levels.map((l) => ({
          column: l.column,
          displayName: l.displayName ?? "",
          isOptional: l.isOptional ?? false,
          stopperValue: l.stopperValue ?? null,
        }))
      : [{ column: "", displayName: "", isOptional: false, stopperValue: null }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columns =
    overview.tables.find((t) => t.name === table)?.columns.map((c) => c.name) ?? [];

  const updateLevel = (index: number, patch: Partial<LevelDraft>) => {
    setLevels((ls) => ls.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const moveLevel = (index: number, delta: number) => {
    setLevels((ls) => {
      const j = index + delta;
      if (j < 0 || j >= ls.length) return ls;
      const next = [...ls];
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  };

  const canSave =
    name.trim() !== "" &&
    table !== "" &&
    levels.length > 0 &&
    levels.every((l) => l.column !== "");

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertHierarchy({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          table,
          levels: levels.map((l) => ({
            column: l.column,
            displayName: l.displayName.trim() || null,
            isOptional: l.isOptional,
            stopperValue: l.stopperValue,
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
      title={original ? `Edit Hierarchy: ${original.name}` : "New Hierarchy"}
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
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Name" flex={1}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Calendar"
          />
        </Field>
        <Field label="Table" flex={1}>
          <select
            style={styles.input}
            value={table}
            onChange={(e) => {
              setTable(e.target.value);
              // Old columns no longer apply.
              setLevels((ls) => ls.map((l) => ({ ...l, column: "" })));
            }}
          >
            <option value="">(select table)</option>
            {overview.tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>Levels (top to bottom)</label>
        {levels.map((l, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select
              style={{ ...styles.input, flex: 1 }}
              value={l.column}
              onChange={(e) => updateLevel(i, { column: e.target.value })}
            >
              <option value="">(column)</option>
              {columns.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input
              style={{ ...styles.input, flex: 1 }}
              value={l.displayName}
              onChange={(e) => updateLevel(i, { displayName: e.target.value })}
              placeholder="Display name (optional)"
            />
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 12,
                whiteSpace: "nowrap",
              }}
              title="Ragged hierarchy: this level may be skipped for some members."
            >
              <input
                type="checkbox"
                checked={l.isOptional}
                onChange={(e) => updateLevel(i, { isOptional: e.target.checked })}
              />
              optional
            </label>
            <button style={styles.smallBtn} disabled={i === 0} onClick={() => moveLevel(i, -1)}>
              Up
            </button>
            <button
              style={styles.smallBtn}
              disabled={i === levels.length - 1}
              onClick={() => moveLevel(i, 1)}
            >
              Down
            </button>
            <button
              style={styles.smallBtn}
              disabled={levels.length === 1}
              onClick={() => setLevels((ls) => ls.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <div>
          <button
            style={styles.smallBtn}
            onClick={() =>
              setLevels((ls) => [
                ...ls,
                { column: "", displayName: "", isOptional: false, stopperValue: null },
              ])
            }
          >
            Add level
          </button>
        </div>
      </div>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
