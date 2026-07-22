//! FILENAME: app/extensions/_shared/dsl/pivotLayout/paramSubstitution.ts
// PURPOSE: Resolve `@Name` parameters in a design-query DSL to the current
//   control / ribbon-filter value BEFORE compiling — THE standard way any
//   query-bound object (grid report, design-query chart, future visuals) binds
//   its FILTERS to a pane control or ribbon filter. Pure text substitution (no
//   DSL grammar change): `@Style` -> `("W")`, then the normal compiler runs.
//   Lives in _shared/dsl because it is DSL-level, not object-level; the
//   control-change refresh side is _shared/lib/queryObjectRefresh.ts.
//
// Grammar — @params are recognized ONLY on FILTERS lines; an `@` anywhere else
// (comments, ROWS/CALC lines) or inside a quoted string value is left untouched:
//   @Name         bare name: letters (unicode), digits, `_`; must start with a
//                 letter or `_` (e.g. @Region, @Område)
//   @"Any name"   quoted name: anything except `"` — needed for names with spaces
//                 or dots, e.g. @"Products.Category" (the default ribbon-filter
//                 name is its dotted field name)
//
// Value mapping:
//   unset / empty text / "(All)"  -> the FILTERS line is DROPPED (field unfiltered)
//   empty textList (Select None)  -> matches nothing — the report shows zero data
//                                    rows, mirroring how an empty ribbon-filter
//                                    selection empties its target pivots
//   otherwise                     -> a DSL value list: ("W") / ("A", "B")

import type { ControlValue } from "@api/controlValues";
import { BARE_PARAM_NAME_RE } from "./paramNames";

export { isBareParamName, paramReference } from "./paramNames";

/** Substituted for an empty selection: a value no real data contains, so the
 *  filter matches nothing (parity with pivots emptied by a "Select None"). */
const EMPTY_SELECTION_SENTINEL = "__CALCULA_EMPTY_SELECTION__";

/** Format a control value as a DSL value list, e.g. `("W")` or `("A", "B")`. */
function formatValueList(v: ControlValue): string {
  switch (v.kind) {
    case "text":
      return `("${escapeQuotes(v.value)}")`;
    case "number":
      return `("${v.value}")`;
    case "boolean":
      return `("${v.value ? "TRUE" : "FALSE"}")`;
    case "textList":
      return v.value.length
        ? `(${v.value.map((s) => `"${escapeQuotes(s)}"`).join(", ")})`
        : `("${EMPTY_SELECTION_SENTINEL}")`;
  }
}

/** DSL string literals escape a literal `"` as `""` (supported by the lexer). */
function escapeQuotes(s: string): string {
  return s.replace(/"/g, '""');
}

/** True when a control value means "no selection / all" (drops the filter line).
 *  NOTE: an empty textList is NOT "all" — it is an applied empty selection
 *  ("Select None") and must match nothing, like it does for pivots. */
function isAll(v: ControlValue | undefined): boolean {
  if (!v) return true;
  if (v.kind === "text") return v.value === "" || v.value === "(All)";
  return false;
}

function isFiltersLine(line: string): boolean {
  return /^\s*FILTERS\s*:/i.test(line);
}

interface ParamToken {
  /** Index of the `@`. */
  start: number;
  /** Index just past the token (past the closing quote for quoted names). */
  end: number;
  name: string;
}

/**
 * Scan one FILTERS line for @param tokens, ignoring `@` inside quoted string
 * values (data like "bob@example.com") and after an unquoted `#` (trailing
 * comment) — mirroring the DSL lexer's string/comment rules, including the
 * doubled-quote ("") escape.
 */
function scanParamTokens(line: string): ParamToken[] {
  const tokens: ParamToken[] = [];
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inString && line[i + 1] === '"') {
        i++; // escaped quote inside a string
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "#") break; // trailing comment
    if (ch !== "@") continue;

    if (line[i + 1] === '"') {
      const close = line.indexOf('"', i + 2);
      if (close > i + 2) {
        tokens.push({ start: i, end: close + 1, name: line.slice(i + 2, close) });
        i = close;
      }
    } else {
      const m = BARE_PARAM_NAME_RE.exec(line.slice(i + 1));
      if (m) {
        tokens.push({ start: i, end: i + 1 + m[0].length, name: m[0] });
        i += m[0].length;
      }
    }
  }
  return tokens;
}

/** All @param names referenced by the DSL's FILTERS lines (in order, may repeat). */
export function extractControlParams(dslText: string): string[] {
  const names: string[] = [];
  for (const line of dslText.split("\n")) {
    if (!isFiltersLine(line)) continue;
    for (const t of scanParamTokens(line)) names.push(t.name);
  }
  return names;
}

/** True if the DSL references any `@Name` param (on a FILTERS line). */
export function hasControlParams(dslText: string): boolean {
  return extractControlParams(dslText).length > 0;
}

/**
 * True if the DSL references any of `names` (case-insensitive, matching the
 * control provider's lookup). Used to refresh only the reports bound to the
 * controls that actually changed.
 */
export function dslReferencesControl(dslText: string, names: Iterable<string>): boolean {
  const upper = new Set<string>();
  for (const n of names) upper.add(n.toUpperCase());
  if (upper.size === 0) return false;
  return extractControlParams(dslText).some((n) => upper.has(n.toUpperCase()));
}

/**
 * Substitute `@Name` parameters with their current control values.
 * `resolve(name)` returns the control's value (undefined if missing).
 * Only FILTERS lines are rewritten; every other line passes through verbatim.
 */
export function substituteControlParams(
  dslText: string,
  resolve: (name: string) => ControlValue | undefined,
): string {
  const lines = dslText.split("\n");
  const out: string[] = [];

  for (const line of lines) {
    if (!isFiltersLine(line)) {
      out.push(line);
      continue;
    }
    const tokens = scanParamTokens(line);
    if (tokens.length === 0) {
      out.push(line);
      continue;
    }

    // If any referenced control on the line is unset/(All), drop the whole line
    // (that field is unfiltered -> all values shown).
    if (tokens.some((t) => isAll(resolve(t.name)))) {
      continue;
    }

    // Splice replacements by position (no String.replace — its `$`-expansion
    // would corrupt values containing $&, $`, $' or $$).
    let result = "";
    let cursor = 0;
    for (const t of tokens) {
      result += line.slice(cursor, t.start);
      const v = resolve(t.name);
      result += v ? formatValueList(v) : "";
      cursor = t.end;
    }
    result += line.slice(cursor);
    out.push(result);
  }

  return out.join("\n");
}

