// FILENAME: app/extensions/ModelEditor/cli/transformSteps.ts
// PURPOSE: The `transform` verb's step vocabulary: the CLI spelling of each of
//          the engine's 17 transformation steps, the option->TransformStepDto
//          builder, the 1-based step-index arithmetic the whole verb speaks,
//          and the one-line rendering `show table` prints.
// CONTEXT: Deliberately session-free and gateway-free — writers.ts owns the
//          read-modify-write against the model, this file owns what a step IS.
//          The option SPECS live here too, next to the code that reads them,
//          and modelOptions.ts spreads them into the `table` kind's audited
//          table: one source of truth for strict validation, completion, help.
//          Every serialized spelling below mirrors the engine's serde output
//          (model-engine-lib/crates/engine-core/src/transform/{step,parts}.rs):
//          step tags and field names are camelCase, but `DataType` and
//          `AggregateOp` carry no `rename_all` and stay PascalCase.

import type { CliOptionSpec } from "../../_shared/cli/optionSchema";
import type { TransformStepDto } from "@api";
import { CliError } from "./lex";
import type { ValueTok } from "./lex";
import { optAll, optBool, optList, optNum, optStr, usedOptKeys } from "./parse";
import type { Command } from "./parse";
import { dataType, DATA_TYPE_NAMES } from "./dataTypes";

function fail(msg: string, line: number): never {
  throw new CliError(msg, line);
}

// ---------------------------------------------------------------------------
// Step vocabulary
// ---------------------------------------------------------------------------

/** The engine's step tags, in the order the help/reference lists them. */
export const TRANSFORM_STEP_TYPES = [
  "removeColumns",
  "selectColumns",
  "renameColumns",
  "changeType",
  "filterRows",
  "addColumn",
  "splitColumn",
  "replaceValues",
  "textTransform",
  "fillDown",
  "removeDuplicates",
  "sort",
  "groupBy",
  "keepRows",
  "removeRows",
  "unpivot",
  "pivot",
] as const;

export type TransformStepType = (typeof TRANSFORM_STEP_TYPES)[number];

/** Extra user spellings (lowercased) beyond the canonical tags. A singular
 *  `renameColumn` reads better for the one-rename form the CLI writes. */
const STEP_TYPE_ALIASES: Record<string, TransformStepType> = {
  renamecolumn: "renameColumns",
  removecolumn: "removeColumns",
  selectcolumn: "selectColumns",
  keepcolumns: "selectColumns",
  changetypes: "changeType",
  filter: "filterRows",
  filterrow: "filterRows",
  split: "splitColumn",
  replace: "replaceValues",
  text: "textTransform",
  dedupe: "removeDuplicates",
  distinct: "removeDuplicates",
  group: "groupBy",
  keeprow: "keepRows",
  removerow: "removeRows",
};

/** Normalize a user-typed step name to its engine tag, or null. */
export function normalizeStepType(word: string): TransformStepType | null {
  const w = word.toLowerCase();
  const canonical = TRANSFORM_STEP_TYPES.find((t) => t.toLowerCase() === w);
  if (canonical) return canonical;
  return STEP_TYPE_ALIASES[w] ?? null;
}

/** The `key=` options each step type reads (`at=` is accepted everywhere and
 *  is not a step field — it places the new step in the list). */
const STEP_OPTION_KEYS: Record<TransformStepType, string[]> = {
  removeColumns: ["columns"],
  selectColumns: ["columns"],
  renameColumns: ["column", "newname"],
  changeType: ["column", "columns", "type", "onerror"],
  filterRows: [],
  addColumn: ["name", "type"],
  splitColumn: ["column", "delimiter", "parts", "keeporiginal"],
  replaceValues: ["column", "find", "replace", "matchentire"],
  textTransform: ["columns", "operation"],
  fillDown: ["columns"],
  removeDuplicates: ["columns"],
  sort: ["by"],
  groupBy: ["groupby", "agg"],
  keepRows: ["range"],
  removeRows: ["range"],
  unpivot: ["columns", "namecolumn", "valuecolumn"],
  pivot: ["namecolumn", "valuecolumn", "aggregate", "values"],
};

/** The step types whose definition is an `= <expression>` tail. */
const EXPRESSION_STEPS: TransformStepType[] = ["filterRows", "addColumn"];

/** The option keys each step type reads (help + the per-step check below). */
export function transformStepOptionKeys(type: TransformStepType): string[] {
  return STEP_OPTION_KEYS[type];
}

// ---------------------------------------------------------------------------
// Option schema (spread into modelOptions.ts's `table` kind, verb `transform`)
// ---------------------------------------------------------------------------

export const TRANSFORM_STEP_OPTIONS: CliOptionSpec[] = [
  { key: "at", type: "number", help: "1-based position to insert the new step at (default: last)" },
  { key: "columns", type: "list", help: "column list: removeColumns selectColumns textTransform fillDown removeDuplicates unpivot changeType" },
  { key: "column", type: "string", help: "single column: renameColumns changeType splitColumn replaceValues" },
  { key: "newname", type: "string", help: "renameColumns: the column's new name" },
  { key: "name", type: "string", help: "addColumn: the new column's name" },
  { key: "type", type: "enum", values: [...DATA_TYPE_NAMES], help: "changeType target type / addColumn declared type" },
  { key: "onerror", type: "enum", values: ["fail", "null"], help: "changeType: unconvertible value -> fail (default) or null" },
  { key: "delimiter", type: "string", help: "splitColumn: literal delimiter, e.g. delimiter=\",\"" },
  { key: "parts", type: "number", help: "splitColumn: how many output columns" },
  { key: "keeporiginal", type: "boolean", help: "splitColumn: keep the source column too" },
  { key: "find", type: "string", help: "replaceValues: the text to look for" },
  { key: "replace", type: "string", help: "replaceValues: the replacement (empty removes)" },
  { key: "matchentire", type: "boolean", help: "replaceValues: match the whole value, not a substring" },
  { key: "operation", type: "enum", values: ["trim", "clean", "upper", "lower"], help: "textTransform: the text operation" },
  { key: "by", type: "list", help: "sort: keys, Col or -Col or Col:desc" },
  { key: "groupby", type: "list", help: "groupBy: the grouping columns, in output order" },
  { key: "agg", type: "list", help: "groupBy: function:column:alias (countrows::Rows); repeatable" },
  { key: "range", type: "string", help: "keepRows/removeRows: first:N | last:N | range:OFFSET:COUNT" },
  { key: "namecolumn", type: "string", help: "unpivot/pivot: the attribute-name column" },
  { key: "valuecolumn", type: "string", help: "unpivot/pivot: the value column" },
  { key: "aggregate", type: "string", help: "pivot: the aggregation in each cell (sum, count, …)" },
  { key: "values", type: "list", help: "pivot: the declared distinct values, in output-column order" },
];

// ---------------------------------------------------------------------------
// Small option readers
// ---------------------------------------------------------------------------

/** A non-empty comma list, required. */
function requiredList(cmd: Command, key: string, type: string): string[] {
  const vals = optList(cmd, key);
  const names = (vals ?? []).map((v) => v.text).filter((t) => t !== "");
  if (names.length === 0) fail(`A ${type} step needs ${key}=<column,column,…>`, cmd.line);
  return names;
}

/** An optional comma list (empty assignment = empty list). */
function optionalList(cmd: Command, key: string): string[] {
  return (optList(cmd, key) ?? []).map((v) => v.text).filter((t) => t !== "");
}

/** A required non-empty string option. */
function requiredStr(cmd: Command, key: string, type: string): string {
  const s = optStr(cmd, key);
  if (s === undefined || s === "") fail(`A ${type} step needs ${key}=<value>`, cmd.line);
  return s;
}

const TEXT_OPERATIONS = ["trim", "clean", "upper", "lower"];

/** Lowercased user spelling -> the engine's `AggregateOp` variant name. */
const AGGREGATE_OPS: Record<string, string> = {
  sum: "Sum",
  count: "Count",
  avg: "Average",
  average: "Average",
  min: "Min",
  max: "Max",
  distinctcount: "DistinctCount",
  countdistinct: "DistinctCount",
  countrows: "CountRows",
  rows: "CountRows",
  median: "Median",
  stdev: "StdevSample",
  stdevsample: "StdevSample",
  stdevpop: "StdevPop",
  variance: "VarSample",
  var: "VarSample",
  varsample: "VarSample",
  varpop: "VarPop",
  anyvalue: "AnyValue",
  mode: "Mode",
};

function aggregateOp(s: string, line: number): string {
  const op = AGGREGATE_OPS[s.toLowerCase()];
  if (!op) {
    fail(
      `Unknown aggregate '${s}' (sum, count, countrows, distinctcount, avg, min, max, median, stdev, stdevpop, var, varpop, anyvalue, mode)`,
      line,
    );
  }
  return op;
}

/** `Col` | `-Col` | `Col:desc` | `Col:asc` -> a SortKey (ascending is the
 *  engine's default and is omitted, mirroring its `skip_serializing_if`). */
function parseSortKey(text: string, line: number): { column: string; descending?: boolean } {
  let s = text;
  let descending = false;
  if (s.startsWith("-")) {
    descending = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const idx = s.lastIndexOf(":");
  if (idx > 0) {
    const suffix = s.slice(idx + 1).toLowerCase();
    if (suffix === "desc" || suffix === "descending") {
      descending = true;
      s = s.slice(0, idx);
    } else if (suffix === "asc" || suffix === "ascending") {
      descending = false;
      s = s.slice(0, idx);
    }
  }
  if (s === "") fail(`Sort key '${text}' names no column (use by=Amount or by=-Amount)`, line);
  return descending ? { column: s, descending: true } : { column: s };
}

/** `function:column:alias` (column empty for countrows) -> a GroupAggregate. */
function parseAggregate(
  text: string,
  line: number,
): { column?: string; function: string; alias: string } {
  const parts = text.split(":");
  if (parts.length !== 3) {
    fail(
      `Aggregate '${text}' must be function:column:alias (e.g. sum:Amount:Total, countrows::Rows)`,
      line,
    );
  }
  const fn = aggregateOp(parts[0], line);
  const column = parts[1];
  const alias = parts[2];
  if (alias === "") fail(`Aggregate '${text}' needs an output column name (function:column:alias)`, line);
  if (fn !== "CountRows" && column === "") {
    fail(`Aggregate '${text}' needs an input column (only countrows may omit one)`, line);
  }
  return column === "" ? { function: fn, alias } : { column, function: fn, alias };
}

/** `first:N` | `last:N` | `range:OFFSET:COUNT` -> a RowRange. */
function parseRowRange(
  text: string,
  line: number,
): { kind: "firstN" | "lastN" | "range"; count?: number; offset?: number } {
  const parts = text.split(":");
  const head = parts[0].toLowerCase();
  const num = (raw: string | undefined, what: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      fail(`Row range '${text}' needs a whole ${what} (first:N, last:N, range:OFFSET:COUNT)`, line);
    }
    return n;
  };
  if ((head === "first" || head === "firstn") && parts.length === 2) {
    return { kind: "firstN", count: num(parts[1], "row count") };
  }
  if ((head === "last" || head === "lastn") && parts.length === 2) {
    return { kind: "lastN", count: num(parts[1], "row count") };
  }
  if (head === "range" && parts.length === 3) {
    return { kind: "range", offset: num(parts[1], "offset"), count: num(parts[2], "row count") };
  }
  fail(`Row range '${text}' must be first:N, last:N or range:OFFSET:COUNT`, line);
}

// ---------------------------------------------------------------------------
// Step construction
// ---------------------------------------------------------------------------

/** Refuse an option that is declared for `transform` but means nothing to
 *  THIS step type — strict validation is per verb, so without this a
 *  `filterRows` step would silently swallow `column=`. */
function checkStepOptions(cmd: Command, type: TransformStepType): void {
  const keys = STEP_OPTION_KEYS[type];
  const allowed = new Set([...keys, "at"]);
  for (const key of usedOptKeys(cmd)) {
    if (allowed.has(key)) continue;
    fail(
      `Option '${key}=' does not apply to a ${type} step (it accepts: ${
        keys.length > 0 ? keys.map((k) => k + "=").join(", ") : "no options"
      })`,
      cmd.line,
    );
  }
  const wantsExpr = EXPRESSION_STEPS.includes(type);
  if (!wantsExpr && cmd.expr !== null) {
    fail(
      `A ${type} step takes no '= <expression>' (only ${EXPRESSION_STEPS.join(" and ")} do)`,
      cmd.line,
    );
  }
}

/** Build one step from the command's options + expression tail. */
export function buildTransformStep(cmd: Command, type: TransformStepType): TransformStepDto {
  checkStepOptions(cmd, type);
  switch (type) {
    case "removeColumns":
      return { type, columns: requiredList(cmd, "columns", type) };
    case "selectColumns":
      return { type, columns: requiredList(cmd, "columns", type) };
    case "renameColumns": {
      const from = requiredStr(cmd, "column", type);
      const to = requiredStr(cmd, "newname", type);
      return { type, renames: [{ from, to }] };
    }
    case "changeType": {
      const single = optStr(cmd, "column");
      const many = optionalList(cmd, "columns");
      const columns = many.length > 0 ? many : single !== undefined && single !== "" ? [single] : [];
      if (columns.length === 0) {
        fail(`A changeType step needs column=<name> (or columns=<a,b>) and type=<type>`, cmd.line);
      }
      const newType = dataType(requiredStr(cmd, "type", type), cmd.line);
      const step: TransformStepDto = {
        type,
        changes: columns.map((column) => ({ column, newType })),
      };
      const onError = optStr(cmd, "onerror");
      if (onError !== undefined) {
        const policy = onError.toLowerCase();
        if (policy !== "fail" && policy !== "null") {
          fail(`onerror= must be fail or null (got '${onError}')`, cmd.line);
        }
        step.onError = policy;
      }
      return step;
    }
    case "filterRows": {
      if (cmd.expr === null || cmd.expr === "") {
        fail(`A filterRows step needs '= <row condition>'`, cmd.line);
      }
      return { type, condition: cmd.expr };
    }
    case "addColumn": {
      const name = requiredStr(cmd, "name", type);
      if (cmd.expr === null || cmd.expr === "") {
        fail(`An addColumn step needs '= <expression>'`, cmd.line);
      }
      const step: TransformStepDto = { type, name, expression: cmd.expr };
      const declared = optStr(cmd, "type");
      if (declared !== undefined && declared !== "") step.dataType = dataType(declared, cmd.line);
      return step;
    }
    case "splitColumn": {
      const column = requiredStr(cmd, "column", type);
      const delimiter = optStr(cmd, "delimiter");
      if (delimiter === undefined || delimiter === "") {
        fail(`A splitColumn step needs delimiter="<text>"`, cmd.line);
      }
      const parts = optNum(cmd, "parts");
      if (parts === undefined || !Number.isInteger(parts) || parts < 2) {
        fail(`A splitColumn step needs parts=<2 or more>`, cmd.line);
      }
      const step: TransformStepDto = { type, column, delimiter, parts };
      const keep = optBool(cmd, "keeporiginal");
      if (keep !== undefined) step.keepOriginal = keep;
      return step;
    }
    case "replaceValues": {
      const column = requiredStr(cmd, "column", type);
      const find = optStr(cmd, "find");
      if (find === undefined || find === "") fail(`A replaceValues step needs find="<text>"`, cmd.line);
      const step: TransformStepDto = { type, column, find, replace: optStr(cmd, "replace") ?? "" };
      const whole = optBool(cmd, "matchentire");
      if (whole !== undefined) step.matchEntireValue = whole;
      return step;
    }
    case "textTransform": {
      const columns = requiredList(cmd, "columns", type);
      const op = requiredStr(cmd, "operation", type).toLowerCase();
      if (!TEXT_OPERATIONS.includes(op)) {
        fail(`operation= must be ${TEXT_OPERATIONS.join(", ")} (got '${op}')`, cmd.line);
      }
      return { type, columns, operation: op as "trim" | "clean" | "upper" | "lower" };
    }
    case "fillDown":
      return { type, columns: requiredList(cmd, "columns", type) };
    case "removeDuplicates":
      // An empty column list is meaningful here: every column defines the key.
      return { type, columns: optionalList(cmd, "columns") };
    case "sort": {
      const keys = requiredList(cmd, "by", type).map((t) => parseSortKey(t, cmd.line));
      return { type, by: keys };
    }
    case "groupBy": {
      const groupBy = requiredList(cmd, "groupby", type);
      // `agg=` is REPEATABLE (one occurrence per output column), so it reads
      // every occurrence — optList would keep only the last one and silently
      // drop the rest, which is exactly how a two-aggregate group-by would
      // come back missing a column.
      const aggregates = optAll(cmd, "agg")
        .map((v) => v.text)
        .filter((t) => t !== "")
        .map((t) => parseAggregate(t, cmd.line));
      return { type, groupBy, aggregates };
    }
    case "keepRows":
    case "removeRows":
      return { type, range: parseRowRange(requiredStr(cmd, "range", type), cmd.line) };
    case "unpivot":
      return {
        type,
        columns: requiredList(cmd, "columns", type),
        nameColumn: requiredStr(cmd, "namecolumn", type),
        valueColumn: requiredStr(cmd, "valuecolumn", type),
      };
    case "pivot":
      return {
        type,
        nameColumn: requiredStr(cmd, "namecolumn", type),
        valueColumn: requiredStr(cmd, "valuecolumn", type),
        aggregate: aggregateOp(requiredStr(cmd, "aggregate", type), cmd.line),
        valueNames: requiredList(cmd, "values", type),
      };
  }
}

// ---------------------------------------------------------------------------
// Step-index arithmetic (the CLI speaks 1-based; the array is 0-based)
// ---------------------------------------------------------------------------

/** A 1-based step number naming an EXISTING step -> its array index. */
export function stepIndexArg(
  tok: ValueTok | undefined,
  count: number,
  what: string,
  table: string,
  line: number,
): number {
  if (count === 0) fail(`'${table}' has no transformation steps`, line);
  if (!tok) fail(`Give the ${what} step's number, 1 to ${count} ('show table ${table}' lists them)`, line);
  const n = Number(tok.text);
  if (!Number.isInteger(n) || n < 1 || n > count) {
    fail(
      `Step number must be a whole number between 1 and ${count} (got '${tok.text}'; 'show table ${table}' lists the steps)`,
      line,
    );
  }
  return n - 1;
}

/** A 1-based INSERT position (one past the end is legal) -> its array index. */
export function stepInsertPosition(at: number, count: number, line: number): number {
  if (!Number.isInteger(at) || at < 1 || at > count + 1) {
    fail(`at= must be a whole number between 1 and ${count + 1} (got '${at}')`, line);
  }
  return at - 1;
}

// ---------------------------------------------------------------------------
// Rendering + renaming
// ---------------------------------------------------------------------------

/** Rename the output name the step at `index1` introduces.
 *
 *  The engine's steps carry NO display label — a pipeline is a list of typed
 *  operations, and an extra `label` field would be dropped by the backend's
 *  deserializer on the next save. So `transform … rename` renames a name that
 *  really exists in the step, and says so plainly when the step has none. */
export function renameStepOutput(
  step: TransformStepDto,
  newName: string,
  index1: number,
  line: number,
): TransformStepDto {
  if (newName === "") fail(`Give the step's new output name`, line);
  if (step.type === "addColumn") return { ...step, name: newName };
  if (step.type === "renameColumns" && (step.renames ?? []).length === 1) {
    return { ...step, renames: [{ from: step.renames![0].from, to: newName }] };
  }
  fail(
    `Step ${index1} is a ${step.type} step, which introduces no single output name to rename ` +
      `(the engine's steps carry no display label). Only addColumn and one-column renameColumns ` +
      `steps can be renamed — remove and re-add this one instead.`,
    line,
  );
}

function quoted(s: string): string {
  return `"${s}"`;
}

function describeRange(r: TransformStepDto["range"]): string {
  if (!r) return "";
  if (r.kind === "firstN") return `first ${r.count ?? 0}`;
  if (r.kind === "lastN") return `last ${r.count ?? 0}`;
  return `${r.count ?? 0} rows from ${r.offset ?? 0}`;
}

/** One-line rendering of a step, for the `show table` pipeline listing and
 *  the `transform` confirm labels. */
export function describeTransformStep(step: TransformStepDto): string {
  switch (step.type) {
    case "removeColumns":
    case "selectColumns":
    case "fillDown":
      return (step.columns ?? []).join(", ");
    case "removeDuplicates":
      return (step.columns ?? []).length > 0 ? (step.columns ?? []).join(", ") : "(every column)";
    case "renameColumns":
      return (step.renames ?? []).map((r) => `${r.from} -> ${r.to}`).join(", ");
    case "changeType": {
      const casts = (step.changes ?? []).map((c) => `${c.column} -> ${c.newType}`).join(", ");
      return step.onError === "null" ? `${casts} (errors -> null)` : casts;
    }
    case "filterRows":
      return step.condition ?? "";
    case "addColumn":
      return `${step.name ?? "?"} = ${step.expression ?? ""}${step.dataType ? ` : ${step.dataType}` : ""}`;
    case "splitColumn":
      return (
        `${step.column ?? "?"} on ${quoted(step.delimiter ?? "")} into ${step.parts ?? 0}` +
        (step.keepOriginal ? ", keep original" : "")
      );
    case "replaceValues":
      return (
        `${step.column ?? "?"}: ${quoted(step.find ?? "")} -> ${quoted(step.replace ?? "")}` +
        (step.matchEntireValue ? " (whole value)" : "")
      );
    case "textTransform":
      return `${step.operation ?? "?"}: ${(step.columns ?? []).join(", ")}`;
    case "sort":
      return (step.by ?? []).map((k) => `${k.column}${k.descending ? " desc" : ""}`).join(", ");
    case "groupBy": {
      const aggs = (step.aggregates ?? [])
        .map((a) => `${a.alias} = ${a.function}(${a.column ?? ""})`)
        .join(", ");
      return `by ${(step.groupBy ?? []).join(", ")}${aggs ? ` -> ${aggs}` : ""}`;
    }
    case "keepRows":
    case "removeRows":
      return describeRange(step.range);
    case "unpivot":
      return `${(step.columns ?? []).join(", ")} -> ${step.nameColumn ?? "?"} / ${step.valueColumn ?? "?"}`;
    case "pivot":
      return (
        `${step.nameColumn ?? "?"} x ${step.valueColumn ?? "?"} (${step.aggregate ?? "?"})` +
        ` -> ${(step.valueNames ?? []).join(", ")}`
      );
    default:
      return "";
  }
}
