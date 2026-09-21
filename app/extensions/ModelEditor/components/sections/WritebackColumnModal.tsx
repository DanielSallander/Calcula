// FILENAME: app/extensions/ModelEditor/components/sections/WritebackColumnModal.tsx
// PURPOSE: Add/edit modal for writeback columns (engine v21): typed input
//          columns end users fill in from pivots. Configures the value type,
//          key columns (host-row identity), kind (history / master data),
//          display projection, per-type constraints, allowed editors and
//          history-table exposure. Sibling of TableColumnModals.tsx.

import React, { useState } from "react";
import { biModelUpsertWritebackColumn } from "@api";
import type { ModelOverview, ModelTableInfo, ModelWritebackColumnInfo } from "@api";
import { DialogBody, DialogFieldGrid, DialogPane, DialogSection } from "@api/dialogLayout";
import { Field, Modal, styles } from "../editorShared";
import { ExpressionEditorModal } from "../ExpressionEditorModal";
import { ME } from "../theme";

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
      // 600 rendered at 640 anyway (quantiseModalWidth snaps UP the ladder), and
      // 640 is one column's worth of room. 880 is the next step and the right
      // one: 1040 would snap to 1200, which maxWidth 94vw then clamps to ~1081
      // in this window's default 1150px — 94% of the screen stops reading as a
      // dialog at all.
      width={880}
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
      {/* The intro is about the dialog, not about either column, so it spans
          both — which also keeps "the projection below" honest; from inside the
          left column the projection would be beside it, not below it. */}
      <div style={{ ...styles.hint, marginBottom: 8 }}>
        A typed input column end users fill in from pivots. Submissions are collected per key
        into a history store; the projection below decides what the column displays.
      </div>

      {/* WHAT the column is | HOW it behaves. Nothing here is a wizard: the only
          ordering is that dataType, kind and projectionMode gate their own
          follow-ups, so one tall stack bought no sequencing and cost the fold.
          This window is 1150x780, which leaves the Modal body about 575px, and
          the DEFAULT state ran ~800px — the Constraints heading started below
          the fold in every state, and the masterData+expression state ran
          ~1040px. Two columns put each cause next to its effect instead of
          500px above it.
          `scroll={false}` is load-bearing: the host Modal's body is a plain
          BLOCK div, so DialogBody's `flex: 1` is inert, the panes resolve to
          content height and their own `overflow-y: auto` would never engage —
          we would gain two scrollbars that never scroll on top of the Modal's.
          `padding={0}` because that body already supplies the 24px gutters.
          `flexWrap` + a pane minWidth is the answer to this window's 760px
          minimum: DialogBody has no breakpoint of its own, so let the second
          pane wrap onto its own line rather than crush both. */}
      <DialogBody style={{ gap: 16, flexWrap: "wrap" }}>
        <DialogPane scroll={false} grow={1} minWidth={320} padding={0}>
          <DialogSection title="Definition">
            {/* Kept as a plain flex row on purpose. A DialogFieldGrid needs two
                210px tracks plus the gap = 444px, and a pane here is ~408px, so
                the grid would STACK Name and Value type — a regression on a row
                that already sits side by side at any width. */}
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
              {/* Keeps its own scroller: `table.columns` is unbounded, and a
                  200-column host table would otherwise make the pane enormous.
                  150 -> 220 only because the reclaimed height can afford it. */}
              <div
                style={{
                  border: `1px solid ${ME.ctlBorder}`,
                  borderRadius: 3,
                  background: ME.surface,
                  maxHeight: 220,
                  overflowY: "auto",
                  padding: 6,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {table.columns.length === 0 && (
                  <div style={styles.hint}>This table has no columns.</div>
                )}
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
                        color: eligible ? ME.text : ME.text3,
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
                      color: ME.dangerFg,
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
          </DialogSection>
        </DialogPane>

        <DialogPane scroll={false} grow={1} minWidth={320} padding={0}>
          <DialogSection title="Behaviour">
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
                  {/* 60 -> 110: the column is half as wide now, so an
                      expression that used to fit on one line wraps onto two or
                      three. The Edit… escape hatch to Monaco is unchanged. */}
                  <textarea
                    style={{ ...styles.textarea, flex: 1, minHeight: 110 }}
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
          </DialogSection>

          {/* Same heading, now a DialogSection so it matches the other two
              rather than being the only hand-rolled caption in the dialog. */}
          <DialogSection title="Constraints" style={{ marginTop: 10 }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                marginBottom: 8,
              }}
            >
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              Required (a submission must not leave the value empty)
            </label>
            {isNumeric && (
              // Two-up inside a ~400px pane, folding to one column when this
              // window is dragged narrow — which a flex row would not do; it
              // would just crush both inputs. `minWidth: 0` on the inputs is
              // what lets it fold at all: a grid item's automatic minimum is
              // its min-content width, and a bare <input> contributes ~190px of
              // it. The old `flex` props are gone because a grid item ignores
              // them.
              <DialogFieldGrid minColumnWidth={150} maxColumns={2}>
                <Field label="Min" hint="Optional lower bound.">
                  <input
                    style={{ ...styles.input, minWidth: 0 }}
                    value={minText}
                    onChange={(e) => setMinText(e.target.value)}
                    placeholder="(none)"
                  />
                </Field>
                <Field label="Max" hint="Optional upper bound.">
                  <input
                    style={{ ...styles.input, minWidth: 0 }}
                    value={maxText}
                    onChange={(e) => setMaxText(e.target.value)}
                    placeholder="(none)"
                  />
                </Field>
              </DialogFieldGrid>
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
                <DialogFieldGrid minColumnWidth={150} maxColumns={2}>
                  <Field label="Max length" hint="Optional character limit.">
                    <input
                      style={{ ...styles.input, minWidth: 0 }}
                      value={maxLengthText}
                      onChange={(e) => setMaxLengthText(e.target.value)}
                      placeholder="(none)"
                    />
                  </Field>
                  <Field
                    label="Pattern (regex)"
                    hint="Optional regular expression a value must match."
                  >
                    <input
                      style={{ ...styles.input, minWidth: 0 }}
                      value={pattern}
                      onChange={(e) => setPattern(e.target.value)}
                      placeholder="^[A-Z]{2}-\d+$"
                    />
                  </Field>
                </DialogFieldGrid>
              </>
            )}
            {dataType === "Boolean" && (
              <div style={{ ...styles.hint, marginBottom: 8 }}>
                Boolean values need no further constraints.
              </div>
            )}
          </DialogSection>

          <label
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 10 }}
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
        </DialogPane>
      </DialogBody>

      {/* A save error belongs next to the button that refused, so it is a
          SIBLING of the panes (inside a pane it would be a column-local
          footnote) and it sticks to the bottom of the Modal's scrollport — this
          Modal has no slot between its body and its footer, and an error that
          can be scrolled out of view is worse than no error. */}
      {error && (
        <div
          style={{
            position: "sticky",
            bottom: 0,
            background: ME.overlay,
            color: ME.dangerFg,
            fontSize: 12,
            paddingTop: 6,
            marginBottom: 8,
          }}
        >
          {error}
        </div>
      )}

      {/* Also a sibling of DialogBody: this nested Monaco modal is its own
          fixed-position window, not part of either column. */}
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
