//! FILENAME: app/extensions/Charts/lib/chartParams.ts
// PURPOSE: Resolve a chart's declared named parameters (C5 slice 1) into a flat
//          name -> value scope that filter/calculate expressions read from.
// CONTEXT: A ParamSpec value is a literal or a live single-cell reference. The
//          resolved map is injected into the chartFormula scope (buildRowScope),
//          so an expression like `value > [Threshold]` resolves [Threshold].
//          Cell-bound params make the chart react to grid edits (the existing
//          CELLS_UPDATED -> invalidate-all handler re-reads). Selections/widgets
//          build on this same carry vehicle later.

import type { ChartSpec, ParamSpec } from "../types";
import { isDataRangeRef } from "../types";
import type { FormulaValue } from "./chartFormula";
import { resolveParamCell } from "./dataSourceResolver";
import { parseDisplayNumber } from "./chartFieldTypes";

/** Names reserved by the formula scope; a param may not shadow them. */
export const RESERVED_PARAM_NAMES: ReadonlySet<string> = new Set(["$index", "$category", "value", "$value"]);

/**
 * Coerce a raw cell/literal value to a FormulaValue. Mirrors the numeric/boolean
 * coercion the filter shorthand uses: a numeric-looking string becomes a number,
 * TRUE/FALSE (any case) a boolean, everything else a string. Null/undefined ->
 * "" so a referenced param never resolves to undefined.
 */
export function coerceToFormulaValue(raw: string | number | boolean | null | undefined): FormulaValue {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === "boolean") return raw;
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim();
  if (s === "") return "";
  const upper = s.toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return s;
}

/**
 * Coerce a cell's FORMATTED display text to a FormulaValue. Unlike a literal,
 * a cell value may be currency / percent / thousands-separated / locale-formatted
 * (e.g. "$1,000", "50%", sv-SE "3,5"), so it is parsed with the same
 * parseDisplayNumber the chart uses for data cells — keeping a cell-bound param
 * consistent with how the same cell reads as a data value. TRUE/FALSE map to
 * booleans; empty -> "".
 */
export function coerceCellValue(display: string): FormulaValue {
  const s = display.trim();
  if (s === "") return "";
  const upper = s.toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  const n = parseDisplayNumber(s);
  if (Number.isFinite(n)) return n;
  return s;
}

/**
 * Validate a param set, returning human-readable issues (does not throw). Used
 * for editor surfacing and tests; resolveParams independently skips the invalid
 * entries so a bad param degrades gracefully rather than breaking the chart.
 */
export function validateParams(params: ParamSpec[] | undefined): string[] {
  const issues: string[] = [];
  if (!params) return issues;
  const seen = new Set<string>();
  for (const p of params) {
    const name = (p.name ?? "").trim();
    if (name === "") {
      issues.push("A param is missing a name.");
      continue;
    }
    if (RESERVED_PARAM_NAMES.has(name)) {
      issues.push(`Param "${name}" uses a reserved name and is ignored.`);
    }
    if (seen.has(name)) {
      issues.push(`Duplicate param name "${name}" — only the first is used.`);
    }
    seen.add(name);
    if (p.cellRef && p.cellRef.includes("!")) {
      issues.push(`Param "${name}" cellRef "${p.cellRef}" is cross-sheet; only same-sheet refs are supported — the default value is used.`);
    }
  }
  return issues;
}

/**
 * Resolve a spec's declared params to a name -> FormulaValue scope map. Async
 * (cell reads), called once per chart read. Best-effort: a param with a missing/
 * reserved/duplicate name is skipped; every accepted param ALWAYS gets an entry
 * (its cell value, else its literal default, else "") so an expression that
 * references it never throws #NAME?. Empty map when the spec declares no params.
 */
export async function resolveParams(spec: ChartSpec): Promise<Map<string, FormulaValue>> {
  const out = new Map<string, FormulaValue>();
  const params = spec.params;
  if (!params || params.length === 0) return out;

  const sheetIndex = isDataRangeRef(spec.data) ? spec.data.sheetIndex : 0;

  for (const p of params) {
    const name = (p.name ?? "").trim();
    if (name === "" || RESERVED_PARAM_NAMES.has(name) || out.has(name)) continue;

    let resolved: FormulaValue;
    // A same-sheet cell ref is read live; cross-sheet/empty falls back to default.
    if (p.cellRef) {
      const display = await resolveParamCell(p.cellRef, sheetIndex);
      resolved = display !== null ? coerceCellValue(display) : coerceToFormulaValue(p.value ?? "");
    } else {
      resolved = coerceToFormulaValue(p.value ?? "");
    }
    out.set(name, resolved);
  }

  return out;
}
