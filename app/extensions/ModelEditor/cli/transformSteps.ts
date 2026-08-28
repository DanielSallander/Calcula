// FILENAME: app/extensions/ModelEditor/cli/transformSteps.ts
// PURPOSE: What is left of the `transform` verb's step vocabulary once the
//          grammar moved into the engine: the completion/help word lists, the
//          1-based step-index arithmetic the whole verb speaks, and the one
//          output-rename convenience.
// CONTEXT: This file used to BUILD steps. It held its own option table, its own
//          sort-key / aggregate / row-range sub-parsers, and its own prose
//          renderer — a hand-written mirror of the engine's serde that was, in
//          measurable ways, WRONG: it could express only one rename per step,
//          only a homogeneous changeType, refused parts<2 where the engine
//          allows 1..=64, required a non-empty groupby= where the engine accepts
//          none, and had no spelling for Decimal at all. So the command line
//          could not re-emit pipelines the step editor itself produced.
//
//          The grammar now lives in ONE place, beside the enum it mirrors
//          (model-engine-lib/crates/engine-core/src/transform/script/), and
//          `transform … add` forwards its raw statement text there. What
//          survives here is a word list for completion, which cannot construct
//          anything and is pinned to the engine's own vocabulary by
//          `__tests__/transformScriptDrift.test.ts`.

import type { CliOptionSpec } from "../../_shared/cli/optionSchema";
import type { TransformStepDto } from "@api";
import { CliError } from "./lex";
import type { ValueTok } from "./lex";
import { DATA_TYPE_NAMES } from "./dataTypes";

function fail(msg: string, line: number): never {
  throw new CliError(msg, line);
}

// ---------------------------------------------------------------------------
// Word lists (completion and help only — these construct nothing)
// ---------------------------------------------------------------------------

/** The engine's step tags, in catalog order.
 *
 *  A DISPLAY list. The engine decides what parses, including the alternative
 *  spellings (`filter`, `dedupe`, `renameColumn`, …) deliberately absent here
 *  so completion offers one canonical name per step. */
export const TRANSFORM_STEP_TYPES = [
  "removeColumns",
  "selectColumns",
  "renameColumns",
  "changeType",
  "filterRows",
  "addColumn",
  "transformColumn",
  "lookupColumn",
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

/**
 * The option keys a step statement accepts, flattened across every step.
 *
 * Spread into modelOptions.ts's `table` kind so completion and `help` have
 * something to offer synchronously. It is deliberately PERMISSIVE: whether an
 * option applies to the step being written is decided by the engine's parser,
 * which is the only place that knows. The list is diffed against the engine's
 * published vocabulary by the drift test, so a step that gains an option gains
 * it here too or the test names it.
 */
export const TRANSFORM_STEP_OPTIONS: CliOptionSpec[] = [
  { key: "at", type: "number", help: "1-based position to insert the new step at (default: last)" },
  { key: "columns", type: "list", help: "column list: removeColumns selectColumns textTransform fillDown removeDuplicates unpivot" },
  { key: "rename", type: "string", aliases: ["newname"], help: "renameColumns: one rename, written oldName:newName (repeatable)" },
  { key: "cast", type: "string", aliases: ["type"], help: "changeType: one cast, written column:Int64 (repeatable)" },
  { key: "onError", type: "enum", values: ["fail", "null"], help: "changeType: unconvertible value -> fail (default) or null" },
  { key: "name", type: "string", help: "addColumn: the new column's name" },
  { key: "dataType", type: "enum", values: [...DATA_TYPE_NAMES], help: "addColumn/transformColumn: declared type; omit to infer" },
  { key: "column", type: "string", help: "single column: transformColumn splitColumn replaceValues" },
  { key: "delimiter", type: "string", help: "splitColumn: literal delimiter, e.g. delimiter=\",\"" },
  { key: "parts", type: "number", help: "splitColumn: how many output columns" },
  { key: "keepOriginal", type: "boolean", help: "splitColumn: keep the source column too" },
  { key: "find", type: "string", help: "replaceValues: the text to look for" },
  { key: "replace", type: "string", help: "replaceValues: the replacement (empty removes)" },
  { key: "matchEntireValue", type: "boolean", aliases: ["matchEntire"], help: "replaceValues: match the whole value, not a substring" },
  { key: "operation", type: "enum", values: ["trim", "clean", "upper", "lower"], help: "textTransform: the text operation" },
  { key: "by", type: "list", help: "sort: keys, Col or -Col or Col:desc" },
  { key: "groupBy", type: "list", help: "groupBy: the grouping columns, in output order" },
  { key: "agg", type: "string", help: "groupBy: Function:column:alias (CountRows::Rows); repeatable" },
  { key: "aggFormula", type: "string", help: 'groupBy: Function:"formula":alias - the SUMIF shape; repeatable' },
  { key: "range", type: "string", help: "keepRows/removeRows: first:N | last:N | range:OFFSET:COUNT" },
  { key: "nameColumn", type: "string", help: "unpivot/pivot: the attribute-name column" },
  { key: "valueColumn", type: "string", help: "unpivot/pivot: the value column" },
  { key: "aggregate", type: "string", help: "pivot: the aggregation in each cell (Sum, Count, ...)" },
  { key: "valueNames", type: "list", aliases: ["values"], help: "pivot: the declared distinct values, in output-column order" },
  { key: "table", type: "string", help: "lookupColumn: the model table to bring columns across from" },
  { key: "on", type: "string", help: "lookupColumn: one key pair, written hostColumn:targetColumn (repeatable, ANDed)" },
  { key: "take", type: "string", help: "lookupColumn: one column to bring across, or column:newName (repeatable)" },
];

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
// Output rename
// ---------------------------------------------------------------------------

/** Rename the output name the step at `index1` introduces.
 *
 *  The engine's steps carry NO display label — a pipeline is a list of typed
 *  operations, and an extra `label` field would be dropped by the backend's
 *  deserializer on the next save. So `transform … rename` renames a name that
 *  really exists in the step, and says so plainly when the step has none.
 *
 *  This is the one place outside the engine that still reads a step's fields.
 *  It touches two of nineteen tags and is checked by the drift test, which
 *  asserts both still carry the field this reaches for. */
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
