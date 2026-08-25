// FILENAME: app/extensions/ModelEditor/cli/dataTypes.ts
// PURPOSE: ONE spelling table for the engine's column data types, shared by
//          everything in the CLI that accepts a `type=` option: writers.ts
//          (add/set column, writeback), transformSteps.ts (changeType,
//          addColumn) and modelOptions.ts's completion/help enum values.
// CONTEXT: The canonical names are the engine's serde spellings — `DataType`
//          (model-engine-lib/crates/engine-core/src/types.rs) carries NO
//          `rename_all`, so it serializes as PascalCase variant names and a
//          lowercase spelling would be rejected at the boundary.

import { CliError } from "./lex";

/** Canonical engine spellings, in completion/help display order. */
export const DATA_TYPE_NAMES = [
  "String",
  "Int32",
  "Int64",
  "Float64",
  "Boolean",
  "Date",
  "Timestamp",
] as const;

/** Lowercased user spelling -> canonical engine spelling. */
const DATA_TYPE_ALIASES: Record<string, string> = {
  string: "String",
  text: "String",
  int: "Int64",
  int32: "Int32",
  int64: "Int64",
  float: "Float64",
  float64: "Float64",
  double: "Float64",
  number: "Float64",
  boolean: "Boolean",
  bool: "Boolean",
  date: "Date",
  timestamp: "Timestamp",
  datetime: "Timestamp",
};

/** Resolve a user-typed data type to its engine spelling, or fail. */
export function dataType(s: string, line: number): string {
  const t = DATA_TYPE_ALIASES[s.toLowerCase()];
  if (!t) {
    throw new CliError(
      `Unknown data type '${s}' (${DATA_TYPE_NAMES.join(", ")})`,
      line,
    );
  }
  return t;
}
