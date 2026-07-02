// FILENAME: app/extensions/ModelEditor/components/sections/TableColumnModals.tsx
// PURPOSE: The two column modals of the Tables section: metadata editing for
//          physical columns (bi_model_update_column) and the add/edit modal
//          for calculated columns (bi_model_upsert_calc_column).

import React, { useState } from "react";
import { biModelUpdateColumn, biModelUpsertCalcColumn } from "@api";
import type { ModelColumnInfo, ModelOverview } from "@api";
import { Field, Modal, styles } from "../editorShared";

export const CALC_COLUMN_DATA_TYPES = [
  "String",
  "Int32",
  "Int64",
  "Float64",
  "Boolean",
  "Date",
  "Timestamp",
];

// ============================================================================
// Physical column metadata
// ============================================================================

export function PhysicalColumnModal({
  connectionId,
  table,
  column,
  onClose,
  onSaved,
}: {
  connectionId: string;
  table: string;
  column: ModelColumnInfo;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [displayName, setDisplayName] = useState(column.displayName ?? "");
  const [description, setDescription] = useState(column.description ?? "");
  const [isHidden, setIsHidden] = useState(column.isHidden);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpdateColumn({
          connectionId,
          table,
          column: column.name,
          displayName: displayName.trim() || null,
          description: description.trim() || null,
          isHidden,
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Edit Column: ${table}[${column.name}]`}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button style={styles.primaryBtn} disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <Field label="Display name">
        <input
          style={styles.input}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={column.name}
        />
      </Field>
      <Field label="Description">
        <input
          style={styles.input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={isHidden}
          onChange={(e) => setIsHidden(e.target.checked)}
        />
        Hidden
      </label>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}

// ============================================================================
// Calculated column (add or edit)
// ============================================================================

export function CalcColumnModal({
  connectionId,
  table,
  existing,
  onClose,
  onSaved,
}: {
  connectionId: string;
  table: string;
  /** The calculated column being edited, or null when adding a new one. */
  existing: ModelColumnInfo | null;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(existing?.name ?? "");
  const [formula, setFormula] = useState(existing?.formula ?? "");
  // Keep the editing column's EXACT dataType string even when it is not one
  // of the standard options (e.g. "Decimal(18, 2)") — it becomes an extra
  // <option> below, selected by default, so the type round-trips unchanged
  // instead of being coerced (the backend keeps the original type when the
  // string matches).
  const [dataType, setDataType] = useState(existing ? existing.dataType : "Float64");
  const dataTypeOptions =
    existing && !CALC_COLUMN_DATA_TYPES.includes(existing.dataType)
      ? [existing.dataType, ...CALC_COLUMN_DATA_TYPES]
      : CALC_COLUMN_DATA_TYPES;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && formula.trim() !== "";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await biModelUpsertCalcColumn({
          connectionId,
          originalName: existing?.name ?? null,
          name: name.trim(),
          table,
          formula,
          dataType,
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={existing ? `Edit Calculated Column: ${existing.name}` : "Add Calculated Column"}
      width={520}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={styles.primaryBtn}
            disabled={busy || !canSave}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Name" flex={2}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Margin"
          />
        </Field>
        <Field label="Data type" flex={1}>
          <select
            style={styles.input}
            value={dataType}
            onChange={(e) => setDataType(e.target.value)}
          >
            {dataTypeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Table">
        <input style={styles.input} value={table} disabled />
      </Field>
      <Field
        label="Formula"
        hint="Row-level expression over this table's columns, e.g. [revenue] - [cost]."
      >
        <textarea
          style={{ ...styles.textarea, minHeight: 80 }}
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
        />
      </Field>
      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}
    </Modal>
  );
}
