// FILENAME: app/extensions/ModelEditor/components/sections/CalcGroupsSection.tsx
// PURPOSE: Calculation groups section of the Model Editor window: list groups
//          and add/edit/delete them (named items whose formulas transform the
//          measure in play via SELECTEDMEASURE()). The editor mirrors the
//          Measure editor: one item at a time, its formula front and centre in
//          the shared ExpressionWorkspace; items are switched via a chip strip.

import React, { useRef, useState } from "react";
import { biModelDeleteCalcGroup, biModelUpsertCalcGroup } from "@api";
import type { ModelCalcGroupInfo, ModelOverview } from "@api";
import { ACCENT, Field, Modal, SELECTION_BG, styles } from "../editorShared";
import type { SectionCtx } from "../editorShared";
import { treeStyles } from "../treeKit";
import { ExpressionWorkspace } from "./ExpressionWorkspace";

export function CalcGroupsSection({ ctx }: { ctx: SectionCtx }): React.ReactElement {
  const { connectionId, overview, readOnly, applyOverview, reportError } = ctx;
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ original: ModelCalcGroupInfo | null } | null>(null);

  const selectedGroup = overview.calculationGroups.find((g) => g.name === selected);

  const handleDelete = async (g: ModelCalcGroupInfo) => {
    if (!window.confirm(`Delete calculation group '${g.name}'?`)) return;
    try {
      applyOverview(await biModelDeleteCalcGroup(connectionId, g.name));
      if (selected === g.name) setSelected(null);
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
        <button
          style={styles.btn}
          disabled={readOnly || !selectedGroup}
          onClick={() => selectedGroup && setEditing({ original: selectedGroup })}
        >
          Edit
        </button>
        <button
          style={styles.btn}
          disabled={readOnly || !selectedGroup}
          onClick={() => selectedGroup && void handleDelete(selectedGroup)}
        >
          Delete
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
            style={{
              ...treeStyles.itemRow,
              background: g.name === selected ? SELECTION_BG : undefined,
            }}
            title={g.items.map((i) => i.name).join(", ")}
            onClick={() => setSelected(g.name)}
            onDoubleClick={() => {
              if (!readOnly) setEditing({ original: g });
            }}
          >
            <strong style={treeStyles.itemName}>{g.name}</strong>
            <span style={{ ...styles.muted, whiteSpace: "nowrap", flexShrink: 0 }}>
              — {g.items.length} item{g.items.length === 1 ? "" : "s"}
            </span>
            <span
              style={{
                ...styles.muted,
                fontSize: 12,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {g.items.map((i) => i.name).join(", ")}
            </span>
          </div>
        ))}
      </div>

      {editing && (
        <CalcGroupModal
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
// Add/edit modal — same workspace layout as the Measure editor; one item's
// formula is in the editor at a time, switched via the chip strip.
// ============================================================================

interface ItemDraft {
  /** Stable per-draft identity — keys the workspace so Monaco remounts (and
   *  its undo history resets) exactly when the EDITED ITEM changes, including
   *  when a removal leaves the numeric index unchanged. */
  id: number;
  name: string;
  formula: string;
}

function CalcGroupModal({
  connectionId,
  overview,
  original,
  onClose,
  onSaved,
}: {
  connectionId: string;
  overview: ModelOverview;
  original: ModelCalcGroupInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(original?.name ?? "");
  const [items, setItems] = useState<ItemDraft[]>(() =>
    original && original.items.length > 0
      ? original.items.map((i, idx) => ({ id: idx, ...i }))
      : [{ id: 0, name: "", formula: "" }],
  );
  const nextId = useRef(original?.items.length || 1);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = items[Math.min(sel, items.length - 1)];

  const updateItem = (index: number, patch: Partial<ItemDraft>) => {
    setItems((is) => is.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  };

  const addItem = () => {
    setItems((is) => [...is, { id: nextId.current++, name: "", formula: "" }]);
    setSel(items.length);
  };

  const removeItem = (index: number) => {
    setItems((is) => is.filter((_, j) => j !== index));
    setSel((s) => Math.max(0, s > index ? s - 1 : Math.min(s, items.length - 2)));
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

  const chipStyle = (active: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 10px",
    borderRadius: 12,
    fontSize: 12,
    cursor: "pointer",
    border: active ? `1px solid ${ACCENT}` : "1px solid #ccc",
    background: active ? "#eff5ff" : "#fff",
    color: active ? ACCENT : "#444",
    fontWeight: active ? 600 : 400,
    whiteSpace: "nowrap",
    maxWidth: 220,
  });

  return (
    <Modal
      title={original ? `Edit Calculation Group: ${original.name}` : "New Calculation Group"}
      width={1280}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy || !canSave} onClick={() => void save()}>
            {busy ? "Saving…" : "Save Calculation Group"}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
        A calculation group is a set of named items whose formulas transform whichever measure is
        in play — inside an item formula, SELECTEDMEASURE() references that measure.
      </div>

      {/* Identity row — group name and the selected item's name. */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Field label="Name" flex={1}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Time Intelligence"
          />
        </Field>
        <Field label="Item name" flex={1}>
          <input
            style={styles.input}
            value={current?.name ?? ""}
            onChange={(e) => updateItem(sel, { name: e.target.value })}
            placeholder="e.g. YTD"
          />
        </Field>
      </div>

      {/* Item strip — one chip per item; the selected item's formula is in the editor. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <span style={{ ...styles.label, marginRight: 2 }}>Items</span>
        {items.map((item, i) => (
          <span key={item.id} style={chipStyle(i === sel)} onClick={() => setSel(i)}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {item.name.trim() || `(item ${i + 1})`}
            </span>
            {items.length > 1 && (
              <span
                title="Remove this item"
                style={{ color: "#999", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
                onClick={(e) => {
                  e.stopPropagation();
                  removeItem(i);
                }}
              >
                ×
              </span>
            )}
          </span>
        ))}
        <button style={styles.smallBtn} onClick={addItem}>
          + Add item
        </button>
      </div>

      {/* Workspace: the selected item's formula front-and-centre. Keyed by the
          selected item's IDENTITY so Monaco's undo history doesn't bleed
          across items (an index key would survive removing the selected item). */}
      <ExpressionWorkspace
        key={current?.id ?? -1}
        overview={overview}
        value={current?.formula ?? ""}
        onChange={(v) => updateItem(sel, { formula: v })}
        label={`Formula — ${current?.name.trim() || `(item ${sel + 1})`}`}
        hint="SELECTEDMEASURE() references whichever measure is in play when this item is applied. Drag from the tree to insert."
        hintTitle="Example: CALCULATE(SELECTEDMEASURE(), DATESYTD(Calendar[date])). SELECTEDMEASURE() references whichever measure is in play when the item is applied."
      />

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
