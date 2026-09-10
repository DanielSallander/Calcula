// FILENAME: app/extensions/ModelEditor/components/transform/StepConfigForms.tsx
// PURPOSE: One config form per transformation step type. Each form edits ONLY
//          the fields its `type` owns, so the flat `TransformStepDto` never
//          accumulates operands from a step type it is not.
//
// The two expression steps (filterRows / addColumn) reuse the Model Editor's
// TRANSFORM-SCOPED formula editor (FormulaField), not the measure editor. A
// step runs before its table joins the model, so the measure surface offers
// VAR/GVAR/RETURN that cannot parse here, the whole function catalog including
// the aggregates a step refuses, and columns drawn from the table's FINAL model
// columns rather than the schema reaching this step. All three produce a broken
// formula, so the fix was a scoped surface rather than a better hint.

import React, { useState } from "react";
import type {
  ModelColumnInfo,
  ModelOverview,
  TransformDataType,
  TransformStepDto,
} from "@api";
import { Field, styles } from "../editorShared";
import { FormulaField } from "./FormulaField";
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
import { ME } from "../theme";

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
            <Field label="Formula" hint="Evaluated once per row.">
              <FormulaField
                value={step.expression ?? ""}
                columns={inputColumns}
                readOnly={readOnly}
                placeholder="[amount] - [cost]"
                onChange={(expression) => patch({ expression })}
              />
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

      case "transformColumn":
        return (
          <>
            <Field
              label="Column"
              hint="Rewritten in place: it keeps its position and its formatting."
            >
              <ColumnSelect
                value={step.column ?? ""}
                columns={inputColumns}
                disabled={readOnly}
                onChange={(column) => patch({ column })}
              />
            </Field>
            <Field
              label="Formula"
              hint="Evaluated once per row. The column's own name reads its value BEFORE this step, so [x] * 2 doubles it."
            >
              <FormulaField
                value={step.expression ?? ""}
                columns={inputColumns}
                readOnly={readOnly}
                placeholder={step.column ? `UPPER(TRIM([${step.column}]))` : "UPPER(TRIM([status]))"}
                onChange={(expression) => patch({ expression })}
              />
            </Field>
            <Field
              label="Declared type"
              hint="Leave inferred unless the engine says it cannot infer one. The formula's type wins over the column's old one."
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
                <option value="">(infer from the formula)</option>
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
            hint="Keeps rows where this is true; a row where it is blank is dropped. Use AND / OR, not && / ||."
          >
            <FormulaField
              value={step.condition ?? ""}
              columns={inputColumns}
              readOnly={readOnly}
              placeholder={'[amount] > 0 AND [status] <> "cancelled"'}
              onChange={(condition) => patch({ condition })}
            />
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
                      ) : a.expression !== undefined ? (
                        <div style={{ flex: 1, minWidth: 220 }}>
                          <FormulaField
                            value={a.expression ?? ""}
                            columns={inputColumns}
                            readOnly={readOnly}
                            minHeight={34}
                            placeholder={'IF([status] = "open", [amount], BLANK())'}
                            onChange={(expression) =>
                              patch({
                                aggregates: aggregates.map((x, j) =>
                                  j === i ? { ...x, expression, column: undefined } : x,
                                ),
                              })
                            }
                          />
                        </div>
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
                      {!countsRows && (
                        <button
                          style={{
                            ...styles.smallBtn,
                            fontStyle: "italic",
                            fontWeight: 600,
                            background: a.expression !== undefined ? ME.accent : undefined,
                            color: a.expression !== undefined ? ME.onAccent : undefined,
                          }}
                          disabled={readOnly}
                          title={
                            a.expression !== undefined
                              ? "Back to a plain column"
                              : 'Aggregate a formula instead of a column - the SUMIF shape: Sum over IF([status] = "open", [amount], BLANK())'
                          }
                          onClick={() =>
                            patch({
                              aggregates: aggregates.map((x, j) => {
                                if (j !== i) return x;
                                // Switching modes clears the other operand:
                                // the engine refuses an aggregate naming both.
                                if (x.expression !== undefined) {
                                  const next = { ...x, column: inputColumns[0]?.name ?? "" };
                                  delete next.expression;
                                  return next;
                                }
                                const next = { ...x, expression: "" };
                                delete next.column;
                                return next;
                              }),
                            })
                          }
                        >
                          fx
                        </button>
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
                <div style={{ marginTop: 6, fontSize: 11, color: ME.dangerFg, whiteSpace: "pre-wrap" }}>
                  {detectError}
                </div>
              )}
            </Field>
          </>
        );

      case "lookupColumn": {
        // Every table's full column list is already client-side on `overview`,
        // so the pickers need no round trip — the same reason this form can
        // offer the TARGET's columns as readily as this table's.
        const target = overview.tables.find(
          (t) => t.name.toLowerCase() === (step.table ?? "").toLowerCase(),
        );
        const targetColumns = target?.columns ?? [];
        const keys = step.keys ?? [];
        const takes = step.takes ?? [];

        // A calculated table has no `isCalculated` flag on the DTO; it is the
        // derived table of a materialized global, so its name matches one.
        // Excluding it here is a convenience — the engine refuses it by name
        // either way, and that refusal stays the authority.
        const materialized = new Set(
          overview.globalVariables
            .filter((g) => !g.dynamic)
            .map((g) => g.name.toLowerCase()),
        );
        const candidates = overview.tables.filter(
          (t) =>
            t.name.toLowerCase() !== tableName.toLowerCase() &&
            t.storageMode !== "DirectQuery" &&
            !materialized.has(t.name.toLowerCase()),
        );

        const setKey = (i: number, patchKey: Partial<{ host: string; target: string }>) =>
          patch({ keys: keys.map((k, n) => (n === i ? { ...k, ...patchKey } : k)) });
        const setTake = (
          i: number,
          patchTake: Partial<{ column: string; outputName?: string }>,
        ) => patch({ takes: takes.map((t, n) => (n === i ? { ...t, ...patchTake } : t)) });

        return (
          <>
            <Field
              label="Table to look up"
              hint="Any Import table in this model except this one. Its rows are joined from the model's own cache at refresh, so it is refreshed first."
            >
              <select
                style={{ ...styles.input, width: 260 }}
                value={step.table ?? ""}
                disabled={readOnly}
                onChange={(e) =>
                  // Changing the table invalidates every column chosen from
                  // the old one. Clearing is honest; keeping them would show
                  // names that silently do not exist.
                  patch({ table: e.target.value, keys: [], takes: [] })
                }
              >
                <option value="">(table)</option>
                {step.table !== undefined &&
                  step.table !== "" &&
                  !candidates.some((t) => t.name === step.table) && (
                    <option value={step.table}>{step.table} (not available)</option>
                  )}
                {candidates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Matched on"
              hint="Every pair must match (AND). This never adds rows: if the other table has several matching rows, the smallest value wins; if it has none, the result is blank."
            >
              {keys.length === 0 && (
                <div style={styles.hint}>
                  No key yet — the step needs at least one pair to match on.
                </div>
              )}
              {keys.map((k, i) => (
                <div
                  key={i}
                  style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}
                >
                  <ColumnSelect
                    value={k.host}
                    columns={inputColumns}
                    disabled={readOnly}
                    placeholder="(this table)"
                    onChange={(host) => setKey(i, { host })}
                  />
                  <span style={{ ...styles.muted, fontSize: 11 }}>=</span>
                  <ColumnSelect
                    value={k.target}
                    columns={targetColumns}
                    disabled={readOnly || !step.table}
                    placeholder="(other table)"
                    onChange={(t) => setKey(i, { target: t })}
                  />
                  <button
                    style={styles.smallBtn}
                    disabled={readOnly}
                    title="Remove this key pair"
                    onClick={() => patch({ keys: keys.filter((_, n) => n !== i) })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                style={styles.smallBtn}
                disabled={readOnly || !step.table}
                onClick={() => patch({ keys: [...keys, { host: "", target: "" }] })}
              >
                Add key pair
              </button>
            </Field>

            <Field
              label="Columns to bring across"
              hint="Leave the name blank to keep the other table's own column name. Every column here rides ONE join, so taking three costs no more than taking one."
            >
              {takes.length === 0 && (
                <div style={styles.hint}>
                  No columns chosen — the step would add nothing.
                </div>
              )}
              {takes.map((t, i) => (
                <div
                  key={i}
                  style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}
                >
                  <ColumnSelect
                    value={t.column}
                    columns={targetColumns}
                    disabled={readOnly || !step.table}
                    placeholder="(other table)"
                    onChange={(column) => setTake(i, { column })}
                  />
                  <span style={{ ...styles.muted, fontSize: 11 }}>as</span>
                  <input
                    style={{ ...styles.input, flex: 1, minWidth: 0 }}
                    value={t.outputName ?? ""}
                    placeholder={t.column || "(same name)"}
                    disabled={readOnly}
                    onChange={(e) =>
                      // Empty means "keep the target's name", which the engine
                      // spells as an ABSENT field, not an empty string — the
                      // round-trip assertion compares steps for equality.
                      setTake(i, { outputName: e.target.value === "" ? undefined : e.target.value })
                    }
                  />
                  <button
                    style={styles.smallBtn}
                    disabled={readOnly}
                    title="Remove this column"
                    onClick={() => patch({ takes: takes.filter((_, n) => n !== i) })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                style={styles.smallBtn}
                disabled={readOnly || !step.table}
                onClick={() => patch({ takes: [...takes, { column: "" }] })}
              >
                Add column
              </button>
            </Field>
          </>
        );
      }

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

    </div>
  );
}
