// FILENAME: app/extensions/ModelEditor/components/sections/WritebackColumnModal.tsx
// PURPOSE: Add/edit modal for writeback columns (engine v21): typed input
//          columns end users fill in from pivots. Configures the value type,
//          key columns (host-row identity), kind (history / master data),
//          display projection, per-type constraints, allowed editors and
//          history-table exposure. Sibling of TableColumnModals.tsx.

import React, { useState } from "react";
import { biModelUpsertWritebackColumn } from "@api";
import type { ModelOverview, ModelTableInfo, ModelWritebackColumnInfo } from "@api";
import { Field, Modal, styles } from "../editorShared";
import { ExpressionEditorModal } from "../ExpressionEditorModal";

/** Value types a writeback column can collect (the backend accepts these). */
const WRITEBACK_DATA_TYPES = ["Float64", "Int64", "String", "Boolean"];

/** Host-column types that may serve as row keys (backend validates the same). */
const KEY_ELIGIBLE_TYPES = ["Int64", "String"];

const KIND_OPTIONS = [
  { value: "history", label: "History" },
  { value: "masterData", label: "Master data" },
];

const PROJECTION_OPTIONS = [
  { value: "blank", label: "Blank on reload" },
  { value: "latest", label: "Latest value" },
  { value: "expression", label: "Expression over the history" },
];

export function WritebackColumnModal({
  connectionId,
  table,
  existing,
  overview,
  onClose,
  onSaved,
}: {
  connectionId: string;
  /** The host table — its columns feed the key-column picker. */
  table: ModelTableInfo;
  /** The writeback column being edited, or null when adding a new one. */
  existing: ModelWritebackColumnInfo | null;
  /** The model — feeds the projection-expression editor's completion/hover. */
  overview: ModelOverview;
  onClose: () => void;
  onSaved: (overview: ModelOverview) => void;
}): React.ReactElement {
  const [name, setName] = useState(existing?.name ?? "");
  // Keep an editing column's EXACT dataType string even when it is not one of
  // the standard options — it becomes an extra <option>, selected by default,
  // so the type round-trips unchanged (mirrors CalcColumnModal).
  const [dataType, setDataType] = useState(existing?.dataType ?? "Float64");
  const dataTypeOptions =
    existing && !WRITEBACK_DATA_TYPES.includes(existing.dataType)
      ? [existing.dataType, ...WRITEBACK_DATA_TYPES]
      : WRITEBACK_DATA_TYPES;
  const [keyColumns, setKeyColumns] = useState<string[]>(existing?.keyColumns ?? []);
  const [kind, setKind] = useState(existing?.kind ?? "history");
  const [projectionMode, setProjectionMode] = useState(existing?.projectionMode ?? "latest");
  const [projectionExpression, setProjectionExpression] = useState(
    existing?.projectionExpression ?? "",
  );
  const [required, setRequired] = useState(existing?.required ?? false);
  const [minText, setMinText] = useState(existing?.min != null ? String(existing.min) : "");
  const [maxText, setMaxText] = useState(existing?.max != null ? String(existing.max) : "");
  const [enumText, setEnumText] = useState((existing?.enumValues ?? []).join(", "));
  const [maxLengthText, setMaxLengthText] = useState(
    existing?.maxLength != null ? String(existing.maxLength) : "",
  );
  const [pattern, setPattern] = useState(existing?.pattern ?? "");
  const [editorsText, setEditorsText] = useState((existing?.allowedEditors ?? []).join(", "));
  const [exposeHistory, setExposeHistory] = useState(existing?.exposeHistory ?? false);
  const [exprEditorOpen, setExprEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isNumeric = dataType === "Float64" || dataType === "Int64";
  const isText = dataType === "String";

  const toggleKey = (columnName: string) =>
    setKeyColumns((ks) =>
      ks.includes(columnName) ? ks.filter((k) => k !== columnName) : [...ks, columnName],
    );
  // Keys saved earlier whose host column no longer exists: still shown (as
  // checked, flagged) so the user can uncheck them — otherwise every save
  // would fail backend validation with no way to fix it here.
  const missingKeys = keyColumns.filter((k) => !table.columns.some((c) => c.name === k));

  const canSave =
    name.trim() !== "" &&
    keyColumns.length > 0 &&
    (projectionMode !== "expression" || projectionExpression.trim() !== "");

  const save = async () => {
    setError(null);
    // Parse the optional numeric constraints up front — Number("abc") is NaN,
    // which JSON-serializes as null and would silently DROP the constraint.
    let min: number | null = null;
    let max: number | null = null;
    let maxLength: number | null = null;
    if (isNumeric) {
      if (minText.trim() !== "") {
        min = Number(minText);
        if (!Number.isFinite(min)) {
          setError("Min must be a number.");
          return;
        }
      }
      if (maxText.trim() !== "") {
        max = Number(maxText);
        if (!Number.isFinite(max)) {
          setError("Max must be a number.");
          return;
        }
      }
      if (min !== null && max !== null && min > max) {
        setError("Min cannot exceed max.");
        return;
      }
    }
    if (isText && maxLengthText.trim() !== "") {
      maxLength = Number(maxLengthText);
      if (!Number.isInteger(maxLength) || maxLength <= 0) {
        setError("Max length must be a positive integer.");
        return;
      }
    }
    setBusy(true);
    try {
      onSaved(
        await biModelUpsertWritebackColumn({
          connectionId,
          originalId: existing?.id ?? null,
          name: name.trim(),
          table: table.name,
          dataType,
          keyColumns,
          kind,
          projectionMode,
          projectionExpression:
            projectionMode === "expression" ? projectionExpression.trim() : null,
          required,
          min,
          max,
          enumValues:
            isText ? enumText.split(",").map((e) => e.trim()).filter((e) => e !== "") : [],
          maxLength,
          pattern: isText ? pattern.trim() || null : null,
          allowedEditors:
            kind === "masterData"
              ? editorsText.split(",").map((e) => e.trim()).filter((e) => e !== "")
              : [],
          exposeHistory,
        }),
      );
    } catch (err: unknown) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={
        existing
          ? `Edit Writeback Column: ${table.name}[${existing.name}]`
          : `Add Writeback Column: ${table.name}`
      }
      width={600}
      onClose={onClose}
      footer={
        <>
          <button style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            style={styles.primaryBtn}
            disabled={busy || !canSave}
            title={
              canSave
                ? undefined
                : "Needs a name, at least one key column, and an expression when the Expression projection is chosen."
            }
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ ...styles.hint, marginBottom: 8 }}>
        A typed input column end users fill in from pivots. Submissions are collected per key
        into a history store; the projection below decides what the column displays.
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Name" flex={2}>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="forecast_qty"
          />
        </Field>
        <Field label="Value type" flex={1}>
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
        <input style={styles.input} value={table.name} disabled />
      </Field>

      <Field
        label="Key columns"
        hint="Which host columns identify the row a value belongs to. Only Int64/String columns can be keys — other types are disabled."
      >
        <div
          style={{
            border: "1px solid #ccc",
            borderRadius: 3,
            background: "#fff",
            maxHeight: 150,
            overflowY: "auto",
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {table.columns.length === 0 && <div style={styles.hint}>This table has no columns.</div>}
          {table.columns.map((c) => {
            const eligible = KEY_ELIGIBLE_TYPES.includes(c.dataType);
            return (
              <label
                key={c.name}
                title={
                  eligible
                    ? undefined
                    : `Only Int64/String columns can identify a row — '${c.name}' is ${c.dataType}.`
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: eligible ? "#222" : "#aaa",
                  cursor: eligible ? "pointer" : "not-allowed",
                }}
              >
                <input
                  type="checkbox"
                  disabled={!eligible}
                  checked={keyColumns.includes(c.name)}
                  onChange={() => toggleKey(c.name)}
                />
                {c.name}
                <span style={{ ...styles.hint, fontSize: 11 }}>{c.dataType}</span>
              </label>
            );
          })}
          {missingKeys.map((k) => (
            <label
              key={`missing-${k}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "#a4262c",
                cursor: "pointer",
              }}
            >
              <input type="checkbox" checked onChange={() => toggleKey(k)} />
              {k}
              <span style={{ fontSize: 11 }}>(missing from table — uncheck to fix)</span>
            </label>
          ))}
        </div>
      </Field>

      <Field
        label="Kind"
        hint={
          kind === "masterData"
            ? "Master data: an approval-gated shared value — only the allowed editors below may write, and submissions await approval when distributed via .calp."
            : "History: anyone can write; every submission is kept as full history."
        }
      >
        <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
          {KIND_OPTIONS.map((k) => (
            <label
              key={k.value}
              style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
            >
              <input
                type="radio"
                name="wb-kind"
                checked={kind === k.value}
                onChange={() => setKind(k.value)}
              />
              {k.label}
            </label>
          ))}
        </div>
      </Field>
      {kind === "masterData" && (
        <Field
          label="Allowed editors"
          hint="Comma-separated user names/ids allowed to edit the value. Empty = anyone may propose; approval still applies when distributed."
        >
          <input
            style={styles.input}
            value={editorsText}
            onChange={(e) => setEditorsText(e.target.value)}
            placeholder="alice, bob@example.com"
          />
        </Field>
      )}

      <Field
        label="Display projection"
        hint="What the column shows after a reload — collected values always live in the history store."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          {PROJECTION_OPTIONS.map((p) => (
            <label
              key={p.value}
              style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}
            >
              <input
                type="radio"
                name="wb-projection"
                checked={projectionMode === p.value}
                onChange={() => setProjectionMode(p.value)}
              />
              {p.label}
            </label>
          ))}
        </div>
      </Field>
      {projectionMode === "expression" && (
        <Field
          label="Projection expression"
          hint="Reference the history table as history[...] — e.g. MAX(history[value])."
        >
          <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
            <textarea
              style={{ ...styles.textarea, flex: 1, minHeight: 60 }}
              value={projectionExpression}
              onChange={(e) => setProjectionExpression(e.target.value)}
              placeholder="MAX(history[value])"
            />
            <button style={styles.btn} onClick={() => setExprEditorOpen(true)}>
              Edit…
            </button>
          </div>
        </Field>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, color: "#444", margin: "10px 0 6px" }}>
        Constraints
      </div>
      <label
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 8 }}
      >
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
        />
        Required (a submission must not leave the value empty)
      </label>
      {isNumeric && (
        <div style={{ display: "flex", gap: 8 }}>
          <Field label="Min" flex={1} hint="Optional lower bound.">
            <input
              style={styles.input}
              value={minText}
              onChange={(e) => setMinText(e.target.value)}
              placeholder="(none)"
            />
          </Field>
          <Field label="Max" flex={1} hint="Optional upper bound.">
            <input
              style={styles.input}
              value={maxText}
              onChange={(e) => setMaxText(e.target.value)}
              placeholder="(none)"
            />
          </Field>
        </div>
      )}
      {isText && (
        <>
          <Field
            label="Allowed values (enum)"
            hint="Comma-separated list of accepted values. Empty = any text."
          >
            <input
              style={styles.input}
              value={enumText}
              onChange={(e) => setEnumText(e.target.value)}
              placeholder="Approved, Rejected, Pending"
            />
          </Field>
          <div style={{ display: "flex", gap: 8 }}>
            <Field label="Max length" flex={1} hint="Optional character limit.">
              <input
                style={styles.input}
                value={maxLengthText}
                onChange={(e) => setMaxLengthText(e.target.value)}
                placeholder="(none)"
              />
            </Field>
            <Field label="Pattern (regex)" flex={2} hint="Optional regular expression a value must match.">
              <input
                style={styles.input}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="^[A-Z]{2}-\d+$"
              />
            </Field>
          </div>
        </>
      )}
      {dataType === "Boolean" && (
        <div style={{ ...styles.hint, marginBottom: 8 }}>
          Boolean values need no further constraints.
        </div>
      )}

      <label
        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 4 }}
      >
        <input
          type="checkbox"
          checked={exposeHistory}
          onChange={(e) => setExposeHistory(e.target.checked)}
        />
        Expose history table for reports
      </label>
      <div style={{ ...styles.hint, margin: "2px 0 10px 22px" }}>
        {existing
          ? `The full submission history becomes queryable as '${existing.historyTable}'.`
          : "The full submission history becomes queryable as a synthesized table (its name is assigned on save)."}
      </div>

      {error && <div style={{ color: "red", marginBottom: 8, fontSize: 12 }}>{error}</div>}

      {exprEditorOpen && (
        <ExpressionEditorModal
          title={`Projection expression — ${table.name}[${name.trim() || "writeback column"}]`}
          initialValue={projectionExpression}
          overview={overview}
          hint="Aggregates this column's submission history into one displayed value per key. Reference the history table as history[...] — e.g. MAX(history[value])."
          onClose={() => setExprEditorOpen(false)}
          onSave={(v) => {
            setProjectionExpression(v);
            setExprEditorOpen(false);
          }}
        />
      )}
    </Modal>
  );
}
