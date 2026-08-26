// FILENAME: app/extensions/ModelEditor/components/transform/stepKit.tsx
// PURPOSE: The step vocabulary of the transformation editor (the 17 step types,
//          their defaults, and how a step describes itself in a list) plus the
//          small field widgets every step form reuses (column pickers, ordered
//          column lists, integer fields).
//
// The engine owns the step vocabulary — `TransformStepDto` is deliberately a
// FLAT `type`-discriminated interface rather than a TS union, so the tables in
// this file are the editor's only re-statement of it. Keep the string literals
// here in lockstep with `model-engine-lib/crates/engine-core/src/transform/`
// (`step.rs` for the tags, `parts.rs` for the operand vocabularies).

import React, { useState } from "react";
import type { ModelColumnInfo, TransformDataType, TransformStepDto } from "@api";
import { Badge, styles } from "../editorShared";

// ============================================================================
// Vocabulary
// ============================================================================

export interface StepTypeInfo {
  /** The engine's serialized `type` tag. */
  value: string;
  /** What the picker and the step list call it. */
  label: string;
  /** Picker grouping. */
  group: string;
  /** One-line explanation shown above the step's config form. */
  hint: string;
}

export const STEP_GROUPS = ["Columns", "Rows", "Values", "Reshape"];

export const STEP_TYPES: StepTypeInfo[] = [
  {
    value: "selectColumns",
    label: "Choose columns",
    group: "Columns",
    hint: "Keep only the chosen columns, in the order listed — so this also reorders them.",
  },
  {
    value: "removeColumns",
    label: "Remove columns",
    group: "Columns",
    hint: "Drop the chosen columns; every other column keeps its place.",
  },
  {
    value: "renameColumns",
    label: "Rename columns",
    group: "Columns",
    hint: "Rename columns in place. Position and type are preserved.",
  },
  {
    value: "changeType",
    label: "Change type",
    group: "Columns",
    hint: "Cast columns to new types. A value that will not convert either fails the refresh or becomes blank — you choose.",
  },
  {
    value: "addColumn",
    label: "Add column",
    group: "Columns",
    hint: "Append a computed column, evaluated once per row over this table's columns.",
  },
  {
    value: "splitColumn",
    label: "Split column",
    group: "Columns",
    hint: 'Split one text column on a literal delimiter. Output columns are named "column.1" … "column.N".',
  },
  {
    value: "filterRows",
    label: "Filter rows",
    group: "Rows",
    hint: "Keep the rows a row-level boolean expression accepts. Rows where it evaluates to blank are dropped.",
  },
  {
    value: "keepRows",
    label: "Keep rows",
    group: "Rows",
    hint: "Keep a positional range of rows. Positions only mean something after a Sort step, or from a source that returns rows in a stable order.",
  },
  {
    value: "removeRows",
    label: "Remove rows",
    group: "Rows",
    hint: "Drop a positional range of rows. Same row-order caveat as Keep rows.",
  },
  {
    value: "removeDuplicates",
    label: "Remove duplicates",
    group: "Rows",
    hint: "Keep the first row of each group of duplicates. Choosing no columns means every column.",
  },
  {
    value: "sort",
    label: "Sort rows",
    group: "Rows",
    hint: "Order rows by one or more keys, most significant first.",
  },
  {
    value: "replaceValues",
    label: "Replace values",
    group: "Values",
    hint: "Replace text inside one column. Substring mode is text-only; whole-value mode works on any type whose literals parse.",
  },
  {
    value: "textTransform",
    label: "Transform text",
    group: "Values",
    hint: "Trim, clean, uppercase or lowercase one or more text columns in place. Never changes the schema.",
  },
  {
    value: "fillDown",
    label: "Fill down",
    group: "Values",
    hint: "Replace blanks with the nearest non-blank value above, per column.",
  },
  {
    value: "groupBy",
    label: "Group by",
    group: "Reshape",
    hint: "One row per distinct combination of the grouping columns. The output is exactly the grouping columns plus the aggregates — every other column is dropped.",
  },
  {
    value: "unpivot",
    label: "Unpivot columns",
    group: "Reshape",
    hint: "Turn the chosen columns into an attribute column and a value column, repeating every other column per pair.",
  },
  {
    value: "pivot",
    label: "Pivot column",
    group: "Reshape",
    hint: "Turn distinct values of one column into columns. The values are DECLARED, not discovered — a value present at refresh but not declared here is dropped.",
  },
];

/** The engine's `DataType`, minus `Decimal` (which carries precision/scale and
 *  has no single-select spelling). Serialized PascalCase — the engine's enum
 *  carries no `rename_all`. */
export const STEP_DATA_TYPES = [
  "String",
  "Int32",
  "Int64",
  "Float64",
  "Boolean",
  "Date",
  "Timestamp",
];

/**
 * A column type as text.
 *
 * `DataType::Decimal(u8, i8)` is a TUPLE variant, so it serializes as
 * `{ Decimal: [18, 2] }` rather than as a string — a real value the forms must
 * be able to DISPLAY without mangling. Authoring one is deliberately left to
 * the script pane, whose parser lives in the engine: a decimal spelling parsed
 * here as well would be a second declaration of the same grammar, and this
 * repo has already paid for that once.
 */
export function dataTypeLabel(value: TransformDataType | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return `Decimal(${value.Decimal[0]},${value.Decimal[1]})`;
}

/** The engine's `AggregateOp`, PascalCase for the same reason. */
export const AGGREGATE_OPS: { value: string; label: string }[] = [
  { value: "Sum", label: "Sum" },
  { value: "Count", label: "Count (non-blank)" },
  { value: "CountRows", label: "Count rows" },
  { value: "DistinctCount", label: "Distinct count" },
  { value: "Average", label: "Average" },
  { value: "Min", label: "Min" },
  { value: "Max", label: "Max" },
  { value: "Median", label: "Median" },
  { value: "StdevSample", label: "Std dev (sample)" },
  { value: "StdevPop", label: "Std dev (population)" },
  { value: "VarSample", label: "Variance (sample)" },
  { value: "VarPop", label: "Variance (population)" },
  { value: "AnyValue", label: "Any value" },
  { value: "Mode", label: "Most frequent" },
];

/** `AggregateOp::CountRows` counts rows rather than values, so its input column
 *  is ignored (and omitted from the serialized step). */
export const COUNT_ROWS = "CountRows";

export const TEXT_OPS: { value: "trim" | "clean" | "upper" | "lower"; label: string }[] = [
  { value: "trim", label: "Trim (strip leading/trailing spaces)" },
  { value: "clean", label: "Clean (strip control characters)" },
  { value: "upper", label: "UPPERCASE" },
  { value: "lower", label: "lowercase" },
];

export const ROW_RANGE_KINDS: { value: "firstN" | "lastN" | "range"; label: string }[] = [
  { value: "firstN", label: "First N rows" },
  { value: "lastN", label: "Last N rows" },
  { value: "range", label: "N rows from an offset" },
];

export function stepTypeInfo(type: string): StepTypeInfo | undefined {
  return STEP_TYPES.find((t) => t.value === type);
}

export function stepTypeLabel(type: string): string {
  return stepTypeInfo(type)?.label ?? type;
}

// ============================================================================
// Defaults
// ============================================================================

const nameAt = (columns: ModelColumnInfo[], index: number): string =>
  columns.length > index ? columns[index].name : "";

/** A freshly added step, seeded from the columns that reach it so its pickers
 *  open on something real rather than on "(column)". */
export function defaultStep(type: string, columns: ModelColumnInfo[]): TransformStepDto {
  const first = nameAt(columns, 0);
  const second = nameAt(columns, 1) || first;
  const firstText = columns.find((c) => c.dataType === "String")?.name ?? first;
  switch (type) {
    case "selectColumns":
      // Seeded with everything: "choose columns" starts from the full set and
      // the author takes things away, which is also how the step reorders.
      return { type, columns: columns.map((c) => c.name) };
    case "removeColumns":
      return { type, columns: [] };
    case "renameColumns":
      return { type, renames: first ? [{ from: first, to: first }] : [] };
    case "changeType":
      return {
        type,
        changes: first ? [{ column: first, newType: "String" }] : [],
        onError: "fail",
      };
    case "addColumn":
      return { type, name: "NewColumn", expression: "" };
    case "splitColumn":
      return { type, column: firstText, delimiter: ",", parts: 2, keepOriginal: false };
    case "filterRows":
      return { type, condition: "" };
    case "keepRows":
      return { type, range: { kind: "firstN", count: 100 } };
    case "removeRows":
      return { type, range: { kind: "firstN", count: 1 } };
    case "removeDuplicates":
      return { type, columns: [] };
    case "sort":
      return { type, by: first ? [{ column: first, descending: false }] : [] };
    case "replaceValues":
      return { type, column: firstText, find: "", replace: "", matchEntireValue: false };
    case "textTransform":
      return { type, columns: firstText ? [firstText] : [], operation: "trim" };
    case "fillDown":
      return { type, columns: [] };
    case "groupBy":
      return {
        type,
        groupBy: first ? [first] : [],
        aggregates: [{ function: COUNT_ROWS, alias: "Rows" }],
      };
    case "unpivot":
      return { type, columns: [], nameColumn: "Attribute", valueColumn: "Value" };
    case "pivot":
      return { type, nameColumn: first, valueColumn: second, aggregate: "Sum", valueNames: [] };
    default:
      return { type };
  }
}

// ============================================================================
// Descriptions (step list rows, and the Tables-section pipeline summary)
// ============================================================================

const count = (arr: unknown[] | undefined): number => arr?.length ?? 0;
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The step's headline, e.g. "Filter rows" / "Rename column" / "Group by". */
export function describeStep(step: TransformStepDto): string {
  switch (step.type) {
    case "removeColumns": {
      const n = count(step.columns);
      return n === 1 ? "Remove column" : `Remove ${n} columns`;
    }
    case "selectColumns": {
      const n = count(step.columns);
      return `Choose ${n} ${plural(n, "column", "columns")}`;
    }
    case "renameColumns": {
      const n = count(step.renames);
      return n === 1 ? "Rename column" : `Rename ${n} columns`;
    }
    case "changeType": {
      const n = count(step.changes);
      return n === 1 ? "Change type" : `Change ${n} types`;
    }
    case "filterRows":
      return "Filter rows";
    case "addColumn":
      return step.name ? `Add column ${step.name}` : "Add column";
    case "splitColumn":
      return step.column ? `Split ${step.column}` : "Split column";
    case "replaceValues":
      return step.column ? `Replace in ${step.column}` : "Replace values";
    case "textTransform":
      switch (step.operation) {
        case "trim":
          return "Trim text";
        case "clean":
          return "Clean text";
        case "upper":
          return "Uppercase text";
        case "lower":
          return "Lowercase text";
        default:
          return "Transform text";
      }
    case "fillDown":
      return "Fill down";
    case "removeDuplicates":
      return "Remove duplicates";
    case "sort":
      return "Sort rows";
    case "groupBy":
      return "Group by";
    case "keepRows":
      return "Keep rows";
    case "removeRows":
      return "Remove rows";
    case "unpivot":
      return "Unpivot columns";
    case "pivot":
      return "Pivot column";
    default:
      return stepTypeLabel(step.type);
  }
}

function describeRange(range: TransformStepDto["range"]): string {
  if (!range) return "";
  switch (range.kind) {
    case "firstN":
      return `first ${range.count ?? 0}`;
    case "lastN":
      return `last ${range.count ?? 0}`;
    case "range":
      return `${range.count ?? 0} from row ${range.offset ?? 0}`;
    default:
      return "";
  }
}

/** The step's second line in the list: its actual operands, in one short line. */
export function stepDetail(step: TransformStepDto): string {
  switch (step.type) {
    case "removeColumns":
    case "selectColumns":
    case "textTransform":
    case "fillDown":
    case "unpivot":
      return (step.columns ?? []).join(", ");
    case "removeDuplicates":
      return (step.columns ?? []).length === 0 ? "every column" : (step.columns ?? []).join(", ");
    case "renameColumns":
      return (step.renames ?? []).map((r) => `${r.from} → ${r.to}`).join(", ");
    case "changeType":
      return (step.changes ?? []).map((c) => `${c.column} → ${c.newType}`).join(", ");
    case "filterRows":
      return step.condition ?? "";
    case "addColumn":
      return step.expression ?? "";
    case "splitColumn":
      return `on "${step.delimiter ?? ""}" into ${step.parts ?? 0} parts`;
    case "replaceValues":
      return `"${step.find ?? ""}" → "${step.replace ?? ""}"`;
    case "sort":
      return (step.by ?? [])
        .map((k) => `${k.column}${k.descending ? " desc" : ""}`)
        .join(", ");
    case "groupBy": {
      const keys = (step.groupBy ?? []).join(", ") || "(whole table)";
      const aggs = (step.aggregates ?? [])
        .map((a) => `${a.function}(${a.column ?? ""}) as ${a.alias}`)
        .join(", ");
      return aggs ? `${keys} · ${aggs}` : keys;
    }
    case "keepRows":
    case "removeRows":
      return describeRange(step.range);
    case "pivot":
      return `${step.nameColumn ?? ""} → columns, ${step.aggregate ?? ""}(${step.valueColumn ?? ""})`;
    default:
      return "";
  }
}

/** The one-line pipeline summary the Tables section shows on its card, e.g.
 *  "3 steps: Filter rows, Rename column, Group by". */
export function summarizeSteps(steps: TransformStepDto[], maxNamed = 4): string {
  if (steps.length === 0) return "No transformation steps.";
  const named = steps.slice(0, maxNamed).map(describeStep);
  const rest = steps.length - named.length;
  const list = rest > 0 ? `${named.join(", ")}, +${rest} more` : named.join(", ");
  return `${steps.length} ${plural(steps.length, "step", "steps")}: ${list}`;
}

// ============================================================================
// Field widgets
// ============================================================================

/** A single-column dropdown that never silently loses a name it does not know:
 *  a value missing from `columns` (a column an earlier step renamed away) stays
 *  selectable and is labelled as missing. */
export function ColumnSelect({
  value,
  columns,
  onChange,
  disabled,
  placeholder = "(column)",
  width,
}: {
  value: string;
  columns: ModelColumnInfo[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  width?: number | string;
}): React.ReactElement {
  const known = columns.some((c) => c.name === value);
  return (
    <select
      style={{ ...styles.input, minWidth: 0, ...(width !== undefined ? { width } : { flex: 1 }) }}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {!known && value !== "" && <option value={value}>{value} (missing)</option>}
      {columns.map((c) => (
        <option key={c.name} value={c.name}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** An unordered set of columns as a scrollable checkbox list. Selected names
 *  the pipeline no longer produces are listed first, flagged, and can still be
 *  unchecked — so a step that has drifted can be repaired rather than retyped. */
export function ColumnMultiSelect({
  value,
  columns,
  onChange,
  disabled,
  emptyHint = "No columns reach this step.",
  height = 150,
}: {
  value: string[];
  columns: ModelColumnInfo[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  emptyHint?: string;
  height?: number;
}): React.ReactElement {
  const missing = value.filter((n) => !columns.some((c) => c.name === n));
  const toggle = (name: string, on: boolean) => {
    onChange(on ? [...value, name] : value.filter((n) => n !== name));
  };
  const row = (name: string, isMissing: boolean) => (
    <label
      key={`${isMissing ? "missing-" : ""}${name}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        fontSize: 12,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <input
        type="checkbox"
        disabled={disabled}
        checked={value.includes(name)}
        onChange={(e) => toggle(name, e.target.checked)}
      />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      {isMissing && <Badge tone="warn">missing</Badge>}
    </label>
  );
  return (
    <div>
      <div
        style={{
          maxHeight: height,
          overflowY: "auto",
          border: "1px solid #ccc",
          borderRadius: 3,
          background: "#fff",
          padding: "2px 0",
        }}
      >
        {columns.length === 0 && missing.length === 0 && (
          <div style={{ ...styles.hint, padding: "4px 8px" }}>{emptyHint}</div>
        )}
        {missing.map((n) => row(n, true))}
        {columns.map((c) => row(c.name, false))}
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
        <button
          style={styles.smallBtn}
          disabled={disabled || columns.length === 0}
          onClick={() => onChange(columns.map((c) => c.name))}
        >
          All
        </button>
        <button style={styles.smallBtn} disabled={disabled} onClick={() => onChange([])}>
          None
        </button>
        <span style={{ ...styles.hint, alignSelf: "center" }}>
          {value.length} selected
        </span>
      </div>
    </div>
  );
}

/** An ORDERED column list — used where the engine treats order as meaning
 *  (Choose columns reorders; Group by's keys are the output's leading columns). */
export function OrderedColumnList({
  value,
  columns,
  onChange,
  disabled,
  addLabel = "Add column",
  emptyHint = "No columns chosen.",
}: {
  value: string[];
  columns: ModelColumnInfo[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  addLabel?: string;
  emptyHint?: string;
}): React.ReactElement {
  const remaining = columns.filter((c) => !value.includes(c.name));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const moved = next[index];
    next[index] = next[target];
    next[target] = moved;
    onChange(next);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {value.length === 0 && <div style={styles.hint}>{emptyHint}</div>}
      {value.map((name, i) => {
        const known = columns.some((c) => c.name === name);
        return (
          <div key={`${name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ ...styles.hint, width: 18, textAlign: "right" }}>{i + 1}</span>
            <span style={{ flex: 1, fontSize: 12, minWidth: 0, overflow: "hidden" }}>{name}</span>
            {!known && <Badge tone="warn">missing</Badge>}
            <button
              style={styles.smallBtn}
              disabled={disabled || i === 0}
              title="Move up"
              onClick={() => move(i, -1)}
            >
              &uarr;
            </button>
            <button
              style={styles.smallBtn}
              disabled={disabled || i === value.length - 1}
              title="Move down"
              onClick={() => move(i, 1)}
            >
              &darr;
            </button>
            <button
              style={styles.smallBtn}
              disabled={disabled}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 6 }}>
        <select
          style={{ ...styles.input, flex: 1, minWidth: 0 }}
          value=""
          disabled={disabled || remaining.length === 0}
          onChange={(e) => {
            if (e.target.value) onChange([...value, e.target.value]);
          }}
        >
          <option value="">
            {remaining.length === 0 ? "(every column is already listed)" : `${addLabel}…`}
          </option>
          {remaining.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          style={styles.smallBtn}
          disabled={disabled || remaining.length === 0}
          onClick={() => onChange([...value, ...remaining.map((c) => c.name)])}
        >
          Add all
        </button>
      </div>
    </div>
  );
}

/** An integer field that keeps the author's keystrokes (including a
 *  momentarily empty box) instead of snapping the model back to a default on
 *  every character. Commits only a parseable value. */
export function IntField({
  value,
  onChange,
  min = 0,
  width = 90,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  width?: number;
  disabled?: boolean;
}): React.ReactElement {
  const [text, setText] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);
  // Render-time "adjust state on prop change": an outside edit (undo of a step,
  // a different step selected into the same form) reseeds the box.
  if (value !== lastValue) {
    setLastValue(value);
    setText(String(value));
  }
  return (
    <input
      style={{ ...styles.input, width }}
      value={text}
      disabled={disabled}
      inputMode="numeric"
      onChange={(e) => {
        setText(e.target.value);
        const parsed = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(parsed)) {
          const clamped = Math.max(min, Math.trunc(parsed));
          setLastValue(clamped);
          onChange(clamped);
        }
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/** A list of free-text values (the pivot step's DECLARED value names). */
export function TextList({
  value,
  onChange,
  disabled,
  addLabel = "Add value",
  emptyHint = "No values declared.",
}: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  addLabel?: string;
  emptyHint?: string;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {value.length === 0 && <div style={styles.hint}>{emptyHint}</div>}
      {value.map((v, i) => (
        <div key={i} style={{ display: "flex", gap: 6 }}>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 0 }}
            value={v}
            disabled={disabled}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button
            style={styles.smallBtn}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button style={styles.smallBtn} disabled={disabled} onClick={() => onChange([...value, ""])}>
          {addLabel}
        </button>
      </div>
    </div>
  );
}
