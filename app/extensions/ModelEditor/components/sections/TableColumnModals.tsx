// FILENAME: app/extensions/ModelEditor/components/sections/TableColumnModals.tsx
// PURPOSE: The two column modals of the Tables section: metadata editing for
//          physical columns (bi_model_update_column) and the add/edit modal
//          for calculated columns (bi_model_upsert_calc_column).

import React, { useState } from "react";
import { biModelUpdateColumn, biModelUpsertCalcColumn } from "@api";
import type { ModelColumnInfo, ModelOverview } from "@api";
import { Field, Modal, styles } from "../editorShared";
import { ExpressionEditorModal } from "../ExpressionEditorModal";

export const CALC_COLUMN_DATA_TYPES = [
  "String",
  "Int32",
  "Int64",
  "Float64",
  "Boolean",
  "Date",
  "Timestamp",
];

// Excel-style number formats applied to a column's values in pivots (the pivot
// renderer honors the column's format string via result-column metadata).
const FORMAT_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "General" },
  { value: "0", label: "Integer (1235)" },
  { value: "#,##0", label: "Integer, grouped (1,235)" },
  { value: "#,##0.00", label: "Number (1,234.50)" },
  { value: "$#,##0.00", label: "Currency ($1,234.50)" },
  { value: "[$SEK] #,##0.00", label: "Currency (SEK 1,234.50)" },
  { value: "0.0%", label: "Percent (12.3%)" },
  { value: "0.00%", label: "Percent (12.35%)" },
  { value: "yyyy-mm-dd", label: "Date (2024-12-31)" },
  { value: "yyyy-mm-dd hh:mm", label: "Date-time" },
];
const CUSTOM_FORMAT = "__custom__";

// ============================================================================
// Physical column metadata
// ============================================================================

export function PhysicalColumnModal({
  connectionId,
  table,
  column,
  siblingColumns,
  overview,
  onClose,
  onSaved,
}: {
  connectionId: string;
  table: string;
  column: ModelColumnInfo;
  /** Other column names of this table (for the sort-by dropdown). */
  siblingColumns: string[];
  /** The model — feeds the lookup-expression editor's completion/hover. */
  overview: ModelOverview;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [displayName, setDisplayName] = useState(column.displayName ?? "");
  const [description, setDescription] = useState(column.description ?? "");
  const [isHidden, setIsHidden] = useState(column.isHidden);
  const [lookupResolution, setLookupResolution] = useState(column.lookupResolution ?? "");
  const [sortByColumn, setSortByColumn] = useState(column.sortByColumn ?? "");
  const [format, setFormat] = useState(column.formatString ?? "");
  const [lookupEditorOpen, setLookupEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formatIsPreset = FORMAT_PRESETS.some((p) => p.value === format);

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
          lookupResolution: lookupResolution.trim() || null,
          sortByColumn: sortByColumn.trim() || null,
          formatString: format.trim() || null,
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

      <Field
        label="Number format"
        hint="Excel-style format applied to this column's values in pivots."
      >
        <div style={{ display: "flex", gap: 6 }}>
          <select
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={formatIsPreset ? format : CUSTOM_FORMAT}
            onChange={(e) => {
              if (e.target.value !== CUSTOM_FORMAT) setFormat(e.target.value);
            }}
          >
            {FORMAT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM_FORMAT}>Custom…</option>
          </select>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={format}
            placeholder="e.g. #,##0.00"
            onChange={(e) => setFormat(e.target.value)}
          />
        </div>
      </Field>

      <Field
        label="Sort by column"
        hint="Order this column's values by another column (e.g. MonthName sorted by MonthNumber)."
      >
        <select
          style={styles.input}
          value={siblingColumns.includes(sortByColumn) ? sortByColumn : ""}
          onChange={(e) => setSortByColumn(e.target.value)}
        >
          <option value="">(natural — its own values)</option>
          {siblingColumns
            .filter((n) => n !== column.name)
            .map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
        </select>
      </Field>

      <Field
        label="Lookup default value"
        hint='Resolution when this column is used as a lookup (1:many). Measure syntax, e.g. MIN(col) or IF(DISTINCTCOUNT(col) > 1, "*", MIN(col)). Blank = model default.'
      >
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={lookupResolution}
            onChange={(e) => setLookupResolution(e.target.value)}
            placeholder="MIN(col)"
          />
          <button style={styles.btn} onClick={() => setLookupEditorOpen(true)}>
            Edit…
          </button>
        </div>
      </Field>

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}

      {lookupEditorOpen && (
        <ExpressionEditorModal
          title={`Lookup default value — ${table}[${column.name}]`}
          initialValue={lookupResolution}
          overview={overview}
          hint='Measure-syntax expression resolving 1:many lookup values to one, e.g. MIN(col) or IF(DISTINCTCOUNT(col) > 1, "*", MIN(col)).'
          onClose={() => setLookupEditorOpen(false)}
          onSave={(v) => {
            setLookupResolution(v);
            setLookupEditorOpen(false);
          }}
        />
      )}
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
