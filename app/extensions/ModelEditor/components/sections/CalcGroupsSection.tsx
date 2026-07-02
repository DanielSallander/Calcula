// FILENAME: app/extensions/ModelEditor/components/sections/CalcGroupsSection.tsx
// PURPOSE: Calculation groups section of the Model Editor window: list groups
//          and add/edit/delete them (named items whose formulas transform the
//          measure in play via SELECTEDMEASURE()).

import React, { useState } from "react";
import { biModelDeleteCalcGroup, biModelUpsertCalcGroup } from "@api";
import type { ModelCalcGroupInfo, ModelOverview } from "@api";
import { Field, Modal, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";

export function CalcGroupsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [editing, setEditing] = useState<{ original: ModelCalcGroupInfo | null } | null>(null);

  const handleDelete = async (g: ModelCalcGroupInfo) => {
    if (!window.confirm(`Delete calculation group '${g.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteCalcGroup(connectionId, g.name));
    } catch (err: unknown) {
      reportError(err);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>
          Calculation Groups ({overview.calculationGroups.length})
        </span>
        <button style={styles.btn} disabled={readOnly} onClick={() => setEditing({ original: null })}>
          New
        </button>
      </div>
      <div style={{ ...styles.card, flex: 1, overflowY: "auto", padding: 4 }}>
        {overview.calculationGroups.length === 0 && (
          <div style={{ ...styles.muted, padding: 8 }}>
            No calculation groups defined — create one with New.
          </div>
        )}
        {overview.calculationGroups.map((g) => (
          <div
            key={g.name}
            style={{ ...styles.listRow, cursor: "default", display: "flex", alignItems: "center", gap: 8 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <strong>{g.name}</strong>
                <span style={styles.muted}>
                  {" "}
                  — {g.items.length} item{g.items.length === 1 ? "" : "s"}
                </span>
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
                {g.items.map((i) => i.name).join(", ")}
              </div>
            </div>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => setEditing({ original: g })}>
              Edit
            </button>
            <button style={styles.smallBtn} disabled={readOnly} onClick={() => void handleDelete(g)}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {editing && (
        <CalcGroupModal
          connectionId={connectionId}
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

interface ItemDraft {
  name: string;
  formula: string;
}

function CalcGroupModal({
  connectionId,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  original: ModelCalcGroupInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [items, setItems] = useState<ItemDraft[]>(
    original && original.items.length > 0
      ? original.items.map((i) => ({ ...i }))
      : [{ name: "", formula: "" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateItem = (index: number, patch: Partial<ItemDraft>) => {
    setItems((is) => is.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  };

  const canSave =
    name.trim() !== "" &&
    items.length > 0 &&
    items.every((i) => i.name.trim() !== "" && i.formula.trim() !== "");

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertCalcGroup({
          connectionId,
          originalName: original?.name ?? null,
          name: name.trim(),
          items: items.map((i) => ({ name: i.name.trim(), formula: i.formula })),
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={original ? `Edit Calculation Group: ${original.name}` : "New Calculation Group"}
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
          placeholder="Time Intelligence"
        />
      </Field>

      <div style={styles.field}>
        <label style={styles.label}>Items</label>
        {items.map((item, i) => (
          <div
            key={i}
            style={{
              border: "1px solid #e2e2e2",
              borderRadius: 4,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                style={{ ...styles.input, flex: 1 }}
                value={item.name}
                onChange={(e) => updateItem(i, { name: e.target.value })}
                placeholder="Item name, e.g. YTD"
              />
              <button
                style={styles.smallBtn}
                disabled={items.length === 1}
                onClick={() => setItems((is) => is.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
            <textarea
              style={{ ...styles.textarea, minHeight: 56 }}
              value={item.formula}
              onChange={(e) => updateItem(i, { formula: e.target.value })}
              placeholder="CALCULATE(SELECTEDMEASURE(), DATESYTD(Calendar[date]))"
            />
          </div>
        ))}
        <div>
          <button
            style={styles.smallBtn}
            onClick={() => setItems((is) => [...is, { name: "", formula: "" }])}
          >
            Add item
          </button>
        </div>
        <div style={styles.hint}>
          Inside an item formula, SELECTEDMEASURE() references whichever measure
          is in play when the item is applied.
        </div>
      </div>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
