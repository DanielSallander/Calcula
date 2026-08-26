// FILENAME: app/extensions/ModelEditor/components/transform/StepConfigForms.tsx
// PURPOSE: One config form per transformation step type. Each form edits ONLY
//          the fields its `type` owns, so the flat `TransformStepDto` never
//          accumulates operands from a step type it is not.
//
// The two expression steps (filterRows / addColumn) reuse the Model Editor's
// existing Monaco expression surface (ExpressionEditorModal) rather than
// growing a third editor — the same nesting PhysicalColumnModal already does
// for a column's lookup expression.

import React, { useState } from "react";
import type {
  ModelColumnInfo,
  ModelOverview,
  TransformDataType,
  TransformStepDto,
} from "@api";
import { Field, styles } from "../editorShared";
import { ExpressionEditorModal } from "../ExpressionEditorModal";
import {
  AGGREGATE_OPS,
  COUNT_ROWS,
  ColumnMultiSelect,
  ColumnSelect,
  IntField,
  OrderedColumnList,
  ROW_RANGE_KINDS,
  STEP_DATA_TYPES,
  TEXT_OPS,
  TextList,
  dataTypeLabel,
  stepTypeInfo,
  stepTypeLabel,
} from "./stepKit";

/** Row-level expressions see this table's columns as bare names. Spelled out
 *  under both expression editors so the author does not have to guess — and
 *  spelled with AND/OR, because the expression language has no `&&` / `||`. */
function columnHint(columns: ModelColumnInfo[]): string {
  if (columns.length === 0) return "No columns reach this step.";
  const names = columns.slice(0, 12).map((c) => `${c.name} (${c.dataType})`);
  const rest = columns.length - names.length;
  return `Columns here: ${names.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

export function StepConfigForm({
  step,
  index,
  inputColumns,
  overview,
  tableName,
  readOnly,
  onChange,
  onDetectPivotValues,
}: {
  step: TransformStepDto;
  /** Zero-based position in the pipeline (shown as index + 1). */
  index: number;
  /** The columns that reach this step — the schema after every earlier step. */
  inputColumns: ModelColumnInfo[];
  /** The model, for the expression editor's completion and hover. */
  overview: ModelOverview;
  tableName: string;
  readOnly: boolean;
  onChange: (next: TransformStepDto) => void;
  /** Sample the pipeline up to this step and return the distinct values of a
   *  column — how a pivot step's DECLARED value names get filled in. */
  onDetectPivotValues: (nameColumn: string) => Promise<string[]>;
}): React.ReactElement {
  const [expressionEditor, setExpressionEditor] = useState<"condition" | "expression" | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  const patch = (p: Partial<TransformStepDto>) => onChange({ ...step, ...p });
  const info = stepTypeInfo(step.type);

  const detectValues = async () => {
    setDetecting(true);
    setDetectError(null);
    try {
      const values = await onDetectPivotValues(step.nameColumn ?? "");
      patch({ valueNames: values });
    } catch (err: unknown) {
      setDetectError(String(err));
    } finally {
      setDetecting(false);
    }
  };

  const body = (): React.ReactElement => {
    switch (step.type) {
      // ── Columns ───────────────────────────────────────────────────────────
      case "selectColumns":
        return (
          <Field
            label="Columns to keep, in output order"
            hint="Removing a column here drops it; reordering here reorders the table."
          >
            <OrderedColumnList
              value={step.columns ?? []}
              columns={inputColumns}
              disabled={readOnly}
              onChange={(columns) => patch({ columns })}
              emptyHint="No columns chosen — the step would produce an empty table."
            />
          </Field>
        );

      case "removeColumns":
        return (
          <Field label="Columns to remove">
            <ColumnMultiSelect
              value={step.columns ?? []}
              columns={inputColumns}
              disabled={readOnly}
              onChange={(columns) => patch({ columns })}
            />
          </Field>
        );

      case "renameColumns": {
        const renames = step.renames ?? [];
        return (
          <Field label="Renames" hint="Applied in order; a rename can feed the next one.">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {renames.length === 0 && <div style={styles.hint}>No renames.</div>}
              {renames.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <ColumnSelect
                    value={r.from}
                    columns={inputColumns}
                    disabled={readOnly}
                    onChange={(from) =>
                      patch({ renames: renames.map((x, j) => (j === i ? { ...x, from } : x)) })
                    }
                  />
                  <span style={styles.muted}>&rarr;</span>
                  <input
                    style={{ ...styles.input, flex: 1, minWidth: 0 }}
                    value={r.to}
                    disabled={readOnly}
                    placeholder="new name"
                    onChange={(e) =>
                      patch({
                        renames: renames.map((x, j) =>
                          j === i ? { ...x, to: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <button
                    style={styles.smallBtn}
                    disabled={readOnly}
                    onClick={() => patch({ renames: renames.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div>
                <button
                  style={styles.smallBtn}
                  disabled={readOnly}
                  onClick={() =>
                    patch({
                      renames: [
                        ...renames,
                        {
                          from: inputColumns.length > 0 ? inputColumns[0].name : "",
                          to: "",
                        },
                      ],
                    })
                  }
                >
                  Add rename
                </button>
              </div>
            </div>
          </Field>
        );
      }

      case "changeType": {
        const changes = step.changes ?? [];
        return (
          <>
            <Field label="Casts">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {changes.length === 0 && <div style={styles.hint}>No casts.</div>}
                {changes.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <ColumnSelect
                      value={c.column}
                      columns={inputColumns}
                      disabled={readOnly}
                      onChange={(column) =>
                        patch({ changes: changes.map((x, j) => (j === i ? { ...x, column } : x)) })
                      }
                    />
                    <span style={styles.muted}>&rarr;</span>
                    <select
                      style={{ ...styles.input, width: 150 }}
                      value={dataTypeLabel(c.newType)}
                      disabled={readOnly}
                      onChange={(e) => {
                        // A parameterized type (Decimal) is shown but not
                        // authored here; picking it back is a no-op rather
                        // than a silent downgrade to the string "Decimal(18,2)".
                        if (!STEP_DATA_TYPES.includes(e.target.value)) return;
                        const newType = e.target.value as TransformDataType;
                        patch({
                          changes: changes.map((x, j) => (j === i ? { ...x, newType } : x)),
                        });
                      }}
                    >
                      {!STEP_DATA_TYPES.includes(dataTypeLabel(c.newType)) && (
                        <option value={dataTypeLabel(c.newType)}>
                          {dataTypeLabel(c.newType)} (edit in Script)
                        </option>
                      )}
                      {STEP_DATA_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <button
                      style={styles.smallBtn}
                      disabled={readOnly}
                      onClick={() => patch({ changes: changes.filter((_, j) => j !== i) })}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div>
                  <button
                    style={styles.smallBtn}
                    disabled={readOnly}
                    onClick={() =>
                      patch({
                        changes: [
                          ...changes,
                          {
                            column: inputColumns.length > 0 ? inputColumns[0].name : "",
                            newType: "String",
                          },
                        ],
                      })
                    }
                  >
                    Add cast
                  </button>
                </div>
              </div>
            </Field>
            <Field
              label="When a value will not convert"
              hint="Fail stops the refresh loudly. Blank keeps loading, and makes the column nullable — a silent substitution, so choose it deliberately."
            >
              <select
                style={{ ...styles.input, width: 260 }}
                value={step.onError ?? "fail"}
                disabled={readOnly}
                onChange={(e) => patch({ onError: e.target.value as "fail" | "null" })}
              >
                <option value="fail">Fail the refresh</option>
                <option value="null">Make it blank</option>
              </select>
            </Field>
          </>
        );
      }

      case "addColumn":
        return (
          <>
            <Field label="Column name">
              <input
                style={{ ...styles.input, width: 260 }}
                value={step.name ?? ""}
                disabled={readOnly}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field
              label="Expression"
              hint={`Evaluated once per row. ${columnHint(inputColumns)}`}
            >
              <textarea
                style={{ ...styles.textarea, width: "100%", minHeight: 64 }}
                value={step.expression ?? ""}
                disabled={readOnly}
                placeholder="amount - cost"
                onChange={(e) => patch({ expression: e.target.value })}
              />
              <div style={{ marginTop: 4 }}>
                <button style={styles.smallBtn} onClick={() => setExpressionEditor("expression")}>
                  Edit in expression editor&hellip;
                </button>
              </div>
            </Field>
            <Field
              label="Declared type"
              hint="Leave inferred unless the engine says it cannot infer one."
            >
              <select
                style={{ ...styles.input, width: 200 }}
                value={dataTypeLabel(step.dataType)}
                disabled={readOnly}
                onChange={(e) => {
                  if (e.target.value !== "" && !STEP_DATA_TYPES.includes(e.target.value)) return;
                  const next = { ...step };
                  if (e.target.value === "") delete next.dataType;
                  else next.dataType = e.target.value as TransformDataType;
                  onChange(next);
                }}
              >
                <option value="">(infer from the expression)</option>
                {step.dataType !== undefined &&
                  !STEP_DATA_TYPES.includes(dataTypeLabel(step.dataType)) && (
                    <option value={dataTypeLabel(step.dataType)}>
                      {dataTypeLabel(step.dataType)} (edit in Script)
                    </option>
                  )}
                {STEP_DATA_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </>
        );

      case "splitColumn":
        return (
          <>
            <Field label="Column to split">
              <ColumnSelect
                value={step.column ?? ""}
                columns={inputColumns}
                disabled={readOnly}
                width={260}
                onChange={(column) => patch({ column })}
              />
            </Field>
            <Field label="Delimiter" hint="A literal string, not a regular expression.">
              <input
                style={{ ...styles.input, width: 140 }}
                value={step.delimiter ?? ""}
                disabled={readOnly}
                onChange={(e) => patch({ delimiter: e.target.value })}
              />
            </Field>
            <Field
              label="Parts"
              hint={`Produces ${step.column ? `${step.column}.1 … ${step.column}.${step.parts ?? 0}` : "one column per part"}. A part with no text is blank.`}
            >
              <IntField
                value={step.parts ?? 2}
                min={1}
                disabled={readOnly}
                onChange={(parts) => patch({ parts })}
              />
            </Field>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={step.keepOriginal ?? false}
                disabled={readOnly}
                onChange={(e) => patch({ keepOriginal: e.target.checked })}
              />
              Keep the original column as well
            </label>
          </>
        );

      // ── Rows ──────────────────────────────────────────────────────────────
      case "filterRows":
        return (
          <Field
            label="Condition"
            hint={`Keeps rows where this is true; a row where it is blank is dropped. Use AND / OR, not && / ||. ${columnHint(inputColumns)}`}
          >
            <textarea
              style={{ ...styles.textarea, width: "100%", minHeight: 64 }}
              value={step.condition ?? ""}
              disabled={readOnly}
              placeholder='amount > 0 AND status <> "cancelled"'
              onChange={(e) => patch({ condition: e.target.value })}
            />
            <div style={{ marginTop: 4 }}>
              <button style={styles.smallBtn} onClick={() => setExpressionEditor("condition")}>
                Edit in expression editor&hellip;
              </button>
            </div>
          </Field>
        );

      case "keepRows":
      case "removeRows": {
        const range = step.range ?? { kind: "firstN" as const, count: 1 };
        return (
          <>
            <Field
              label={step.type === "keepRows" ? "Rows to keep" : "Rows to remove"}
              hint="Positions address the row order AT THIS STEP, which is only deterministic after a Sort step or from a source that returns a stable order."
            >
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  style={{ ...styles.input, width: 190 }}
                  value={range.kind}
                  disabled={readOnly}
                  onChange={(e) => {
                    const kind = e.target.value as "firstN" | "lastN" | "range";
                    patch({
                      range:
                        kind === "range"
                          ? { kind, offset: range.offset ?? 0, count: range.count ?? 1 }
                          : { kind, count: range.count ?? 1 },
                    });
                  }}
                >
                  {ROW_RANGE_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                {range.kind === "range" && (
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                    from row
                    <IntField
                      value={range.offset ?? 0}
                      disabled={readOnly}
                      width={80}
                      onChange={(offset) =>
                        patch({ range: { kind: "range", offset, count: range.count ?? 1 } })
                      }
                    />
                  </label>
                )}
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                  count
                  <IntField
                    value={range.count ?? 1}
                    disabled={readOnly}
                    width={80}
                    onChange={(count) =>
                      patch({
                        range:
                          range.kind === "range"
                            ? { kind: "range", offset: range.offset ?? 0, count }
                            : { kind: range.kind, count },
                      })
                    }
                  />
                </label>
              </div>
            </Field>
          </>
        );
      }

      case "removeDuplicates":
        return (
          <Field
            label="Columns that define a duplicate"
            hint="None selected = every column must match. The first row of each duplicate group is kept."
          >
            <ColumnMultiSelect
              value={step.columns ?? []}
              columns={inputColumns}
              disabled={readOnly}
              onChange={(columns) => patch({ columns })}
            />
          </Field>
        );

      case "sort": {
        const by = step.by ?? [];
        return (
          <Field label="Sort keys" hint="Most significant first.">
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {by.length === 0 && <div style={styles.hint}>No sort keys.</div>}
              {by.map((k, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ ...styles.hint, width: 16, textAlign: "right" }}>{i + 1}</span>
                  <ColumnSelect
                    value={k.column}
                    columns={inputColumns}
                    disabled={readOnly}
                    onChange={(column) =>
                      patch({ by: by.map((x, j) => (j === i ? { ...x, column } : x)) })
                    }
                  />
                  <select
                    style={{ ...styles.input, width: 120 }}
                    value={k.descending ? "desc" : "asc"}
                    disabled={readOnly}
                    onChange={(e) =>
                      patch({
                        by: by.map((x, j) =>
                          j === i ? { ...x, descending: e.target.value === "desc" } : x,
                        ),
                      })
                    }
                  >
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                  <button
                    style={styles.smallBtn}
                    disabled={readOnly || i === 0}
                    title="Move up"
                    onClick={() => {
                      const next = [...by];
                      const moved = next[i];
                      next[i] = next[i - 1];
                      next[i - 1] = moved;
                      patch({ by: next });
                    }}
                  >
                    &uarr;
                  </button>
                  <button
                    style={styles.smallBtn}
                    disabled={readOnly}
                    onClick={() => patch({ by: by.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div>
                <button
                  style={styles.smallBtn}
                  disabled={readOnly}
                  onClick={() =>
                    patch({
                      by: [
                        ...by,
                        {
                          column: inputColumns.length > 0 ? inputColumns[0].name : "",
                          descending: false,
                        },
                      ],
                    })
                  }
                >
                  Add sort key
                </button>
              </div>
            </div>
          </Field>
        );
      }

      // ── Values ────────────────────────────────────────────────────────────
      case "replaceValues":
        return (
          <>
            <Field label="Column">
              <ColumnSelect
                value={step.column ?? ""}
                columns={inputColumns}
                disabled={readOnly}
                width={260}
                onChange={(column) => patch({ column })}
              />
            </Field>
            <div style={{ display: "flex", gap: 8 }}>
              <Field label="Find" flex={1}>
                <input
                  style={styles.input}
                  value={step.find ?? ""}
                  disabled={readOnly}
                  onChange={(e) => patch({ find: e.target.value })}
                />
              </Field>
              <Field label="Replace with" flex={1}>
                <input
                  style={styles.input}
                  value={step.replace ?? ""}
                  disabled={readOnly}
                  onChange={(e) => patch({ replace: e.target.value })}
                />
              </Field>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={step.matchEntireValue ?? false}
                disabled={readOnly}
                onChange={(e) => patch({ matchEntireValue: e.target.checked })}
              />
              Match the entire value
            </label>
            <div style={{ ...styles.hint, marginTop: 4 }}>
              Substring matching is text-only. Whole-value matching works on any type whose literals
              parse from what you typed.
            </div>
          </>
        );

      case "textTransform":
        return (
          <>
            <Field label="Operation">
              <select
                style={{ ...styles.input, width: 300 }}
                value={step.operation ?? "trim"}
                disabled={readOnly}
                onChange={(e) =>
                  patch({
                    operation: e.target.value as "trim" | "clean" | "upper" | "lower",
                  })
                }
              >
                {TEXT_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Text columns" hint="Values change; the schema does not.">
              <ColumnMultiSelect
                value={step.columns ?? []}
                columns={inputColumns}
                disabled={readOnly}
                onChange={(columns) => patch({ columns })}
              />
            </Field>
          </>
        );

      case "fillDown":
        return (
          <Field
            label="Columns to fill"
            hint="Each blank takes the nearest non-blank value above it."
          >
            <ColumnMultiSelect
              value={step.columns ?? []}
              columns={inputColumns}
              disabled={readOnly}
              onChange={(columns) => patch({ columns })}
            />
          </Field>
        );

      // ── Reshape ───────────────────────────────────────────────────────────
      case "groupBy": {
        const aggregates = step.aggregates ?? [];
        return (
          <>
            <Field
              label="Group by columns"
              hint="These lead the output; every column that is not a grouping column or an aggregate is dropped."
            >
              <OrderedColumnList
                value={step.groupBy ?? []}
                columns={inputColumns}
                disabled={readOnly}
                onChange={(groupBy) => patch({ groupBy })}
                emptyHint="No grouping columns — the whole table collapses to one row."
              />
            </Field>
            <Field label="Aggregates">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {aggregates.length === 0 && <div style={styles.hint}>No aggregates.</div>}
                {aggregates.map((a, i) => {
                  const countsRows = a.function === COUNT_ROWS;
                  return (
                    <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <select
                        style={{ ...styles.input, width: 165, flexShrink: 0 }}
                        value={a.function}
                        disabled={readOnly}
                        onChange={(e) => {
                          const fn = e.target.value;
                          patch({
                            aggregates: aggregates.map((x, j) => {
                              if (j !== i) return x;
                              // COUNTROWS counts rows, not values: the engine
                              // omits its input column entirely.
                              if (fn === COUNT_ROWS) return { function: fn, alias: x.alias };
                              return { column: x.column ?? "", function: fn, alias: x.alias };
                            }),
                          });
                        }}
                      >
                        {!AGGREGATE_OPS.some((o) => o.value === a.function) && (
                          <option value={a.function}>{a.function}</option>
                        )}
                        {AGGREGATE_OPS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      {countsRows ? (
                        <span style={{ ...styles.hint, flex: 1 }}>(counts rows)</span>
                      ) : (
                        <ColumnSelect
                          value={a.column ?? ""}
                          columns={inputColumns}
                          disabled={readOnly}
                          onChange={(column) =>
                            patch({
                              aggregates: aggregates.map((x, j) =>
                                j === i ? { ...x, column } : x,
                              ),
                            })
                          }
                        />
                      )}
                      <span style={styles.muted}>as</span>
                      <input
                        style={{ ...styles.input, width: 150 }}
                        value={a.alias}
                        disabled={readOnly}
                        placeholder="output name"
                        onChange={(e) =>
                          patch({
                            aggregates: aggregates.map((x, j) =>
                              j === i ? { ...x, alias: e.target.value } : x,
                            ),
                          })
                        }
                      />
                      <button
                        style={styles.smallBtn}
                        disabled={readOnly}
                        onClick={() => patch({ aggregates: aggregates.filter((_, j) => j !== i) })}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
                <div>
                  <button
                    style={styles.smallBtn}
                    disabled={readOnly}
                    onClick={() =>
                      patch({
                        aggregates: [
                          ...aggregates,
                          {
                            column: inputColumns.length > 0 ? inputColumns[0].name : "",
                            function: "Sum",
                            alias: `Sum${aggregates.length + 1}`,
                          },
                        ],
                      })
                    }
                  >
                    Add aggregate
                  </button>
                </div>
              </div>
            </Field>
          </>
        );
      }

      case "unpivot":
        return (
          <>
            <Field
              label="Columns to unpivot"
              hint="Every other column is repeated once per unpivoted pair."
            >
              <ColumnMultiSelect
                value={step.columns ?? []}
                columns={inputColumns}
                disabled={readOnly}
                onChange={(columns) => patch({ columns })}
              />
            </Field>
            <div style={{ display: "flex", gap: 8 }}>
              <Field label="Attribute column name" flex={1}>
                <input
                  style={styles.input}
                  value={step.nameColumn ?? ""}
                  disabled={readOnly}
                  onChange={(e) => patch({ nameColumn: e.target.value })}
                />
              </Field>
              <Field label="Value column name" flex={1}>
                <input
                  style={styles.input}
                  value={step.valueColumn ?? ""}
                  disabled={readOnly}
                  onChange={(e) => patch({ valueColumn: e.target.value })}
                />
              </Field>
            </div>
          </>
        );

      case "pivot":
        return (
          <>
            <div style={{ display: "flex", gap: 8 }}>
              <Field label="Column whose values become columns" flex={1}>
                <ColumnSelect
                  value={step.nameColumn ?? ""}
                  columns={inputColumns}
                  disabled={readOnly}
                  onChange={(nameColumn) => patch({ nameColumn })}
                />
              </Field>
              <Field label="Value column" flex={1}>
                <ColumnSelect
                  value={step.valueColumn ?? ""}
                  columns={inputColumns}
                  disabled={readOnly}
                  onChange={(valueColumn) => patch({ valueColumn })}
                />
              </Field>
            </div>
            <Field label="Aggregate applied within each cell">
              <select
                style={{ ...styles.input, width: 220 }}
                value={step.aggregate ?? "Sum"}
                disabled={readOnly}
                onChange={(e) => patch({ aggregate: e.target.value })}
              >
                {step.aggregate !== undefined &&
                  !AGGREGATE_OPS.some((o) => o.value === step.aggregate) && (
                    <option value={step.aggregate}>{step.aggregate}</option>
                  )}
                {AGGREGATE_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Declared values, in output-column order"
              hint="A schema must be derivable without reading data, so these are declared rather than discovered. A value present at refresh but missing here is DROPPED; a declared value missing from the data gives an all-blank column."
            >
              <TextList
                value={step.valueNames ?? []}
                disabled={readOnly}
                onChange={(valueNames) => patch({ valueNames })}
                addLabel="Add value"
                emptyHint="No values declared yet — the step would produce no pivoted columns."
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <button
                  style={styles.smallBtn}
                  disabled={readOnly || detecting || !step.nameColumn}
                  title="Sample the rows reaching this step and declare the distinct values found"
                  onClick={() => void detectValues()}
                >
                  {detecting ? "Sampling…" : "Detect values from a sample…"}
                </button>
                <span style={styles.hint}>
                  A sample can miss a rare value — check the list before applying.
                </span>
              </div>
              {detectError && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#a4262c", whiteSpace: "pre-wrap" }}>
                  {detectError}
                </div>
              )}
            </Field>
          </>
        );

      default:
        return (
          <div style={styles.hint}>
            This step type ({step.type}) has no editor in this build. Its settings are preserved
            as-is.
          </div>
        );
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {index + 1}. {stepTypeLabel(step.type)}
        </span>
        <span style={{ ...styles.muted, fontSize: 11 }}>{step.type}</span>
      </div>
      {info && <div style={{ ...styles.hint, marginBottom: 8 }}>{info.hint}</div>}
      <div style={{ overflowY: "auto", minHeight: 0, paddingRight: 2 }}>{body()}</div>

      {expressionEditor !== null && (
        <ExpressionEditorModal
          title={
            expressionEditor === "condition"
              ? `Filter rows — ${tableName}`
              : `Add column ${step.name ?? ""} — ${tableName}`
          }
          initialValue={
            (expressionEditor === "condition" ? step.condition : step.expression) ?? ""
          }
          overview={overview}
          hint={
            expressionEditor === "condition"
              ? `Row-level boolean over this table's columns. Use AND / OR, not && / ||. ${columnHint(inputColumns)}`
              : `Row-level expression over this table's columns. ${columnHint(inputColumns)}`
          }
          onClose={() => setExpressionEditor(null)}
          onSave={(value) => {
            patch(expressionEditor === "condition" ? { condition: value } : { expression: value });
            setExpressionEditor(null);
          }}
        />
      )}
    </div>
  );
}
