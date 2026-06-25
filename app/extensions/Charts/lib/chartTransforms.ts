//! FILENAME: app/extensions/Charts/lib/chartTransforms.ts
// PURPOSE: Pure functional data transform pipeline for chart data.
// CONTEXT: Applied after parsing raw cell data, before rendering.
//          Each transform is a pure function: ParsedChartData → ParsedChartData.

import type {
  ParsedChartData,
  TransformSpec,
  TransformDiagnostic,
  FilterTransform,
  SortTransform,
  AggregateTransform,
  CalculateTransform,
  WindowTransform,
  BinTransform,
  AggregateOp,
} from "../types";
import {
  compileFormula,
  toNumber,
  toBoolean,
  type CompiledFormula,
  type FormulaScope,
  type FormulaValue,
} from "./chartFormula";

// ============================================================================
// Public API
// ============================================================================

/**
 * Apply a sequence of transforms to parsed chart data.
 * Each transform is pure — returns a new ParsedChartData without mutating the input.
 *
 * Pass `diagnostics` to collect non-fatal issues (unknown fields, un-evaluable
 * expressions). Transforms still produce best-effort data either way; the array
 * is purely for surfacing problems in the editor (roadmap A5).
 */
export function applyTransforms(
  data: ParsedChartData,
  transforms: TransformSpec[],
  diagnostics?: TransformDiagnostic[],
): ParsedChartData {
  return transforms.reduce((d, t, i) => applyOne(d, t, i, diagnostics), data);
}

// ============================================================================
// Dispatcher
// ============================================================================

function applyOne(
  data: ParsedChartData,
  transform: TransformSpec,
  index: number,
  diagnostics?: TransformDiagnostic[],
): ParsedChartData {
  switch (transform.type) {
    case "filter":
      return applyFilter(data, transform, index, diagnostics);
    case "sort":
      return applySort(data, transform, index, diagnostics);
    case "aggregate":
      return applyAggregate(data, transform, index, diagnostics);
    case "calculate":
      return applyCalculate(data, transform, index, diagnostics);
    case "window":
      return applyWindow(data, transform, index, diagnostics);
    case "bin":
      return applyBin(data, transform, index, diagnostics);
    default: {
      const unknownType = (transform as { type?: string }).type ?? "unknown";
      diagnostics?.push({
        index,
        transformType: unknownType as TransformSpec["type"],
        severity: "warning",
        message: `Unknown transform type "${unknownType}".`,
      });
      return data;
    }
  }
}

/** Push a diagnostic if a collector was provided (no-op otherwise). */
function report(
  diagnostics: TransformDiagnostic[] | undefined,
  index: number,
  transformType: TransformSpec["type"],
  severity: "error" | "warning",
  message: string,
): void {
  diagnostics?.push({ index, transformType, severity, message });
}

/** Extract a readable message from a thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Filter
// ============================================================================

function applyFilter(
  data: ParsedChartData,
  t: FilterTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
): ParsedChartData {
  const { field, predicate } = t;

  const seriesIdx = field === "$category" ? -1 : findSeriesIndex(data, field);
  if (field !== "$category" && seriesIdx < 0) {
    report(diagnostics, index, "filter", "warning", `Filter: unknown field "${field}" — no rows removed.`);
    return data;
  }

  const exprSrc = predicateToExpr(predicate);
  if (exprSrc === null) return data; // Empty predicate: intentional no-op.

  let compiled: CompiledFormula;
  try {
    compiled = compileFormula(exprSrc);
  } catch (err) {
    // Unparseable predicate — leave the data untouched rather than dropping rows.
    report(diagnostics, index, "filter", "warning", `Filter: invalid predicate ${JSON.stringify(predicate)} — ${errMessage(err)}. No rows removed.`);
    return data;
  }

  const sanitized = sanitizeNames(data);
  let errorCount = 0;
  let firstError = "";
  const keep: boolean[] = data.categories.map((cat, ci) => {
    const fieldVal: FormulaValue = field === "$category"
      ? cat
      : (data.series[seriesIdx].values[ci] ?? 0);
    const scope = buildRowScope(data, sanitized, ci, fieldVal);
    try {
      return toBoolean(compiled(scope));
    } catch (err) {
      // A row whose predicate errors (e.g. an unknown name) is kept — filtering
      // must never silently drop data on a broken expression.
      errorCount++;
      if (!firstError) firstError = errMessage(err);
      return true;
    }
  });

  if (errorCount > 0) {
    report(diagnostics, index, "filter", "warning",
      `Filter: predicate could not be evaluated for ${errorCount} of ${keep.length} rows (kept) — ${firstError}.`);
  }

  return filterByMask(data, keep);
}

/**
 * Convert a filter predicate into a boolean formula expression.
 * - Legacy shorthand ("> 100", "!= Total", "= Mar") becomes `value <op> <rhs>`,
 *   with a numeric rhs kept bare and a textual rhs quoted.
 * - Anything else is treated as a full boolean expression and can reference
 *   `value` (the field's value), `$category`, `$index`, and series by name —
 *   e.g. `AND(value > 100, $category <> "Total")`.
 * Returns null for an empty predicate (no filtering applied).
 */
function predicateToExpr(predicate: string): string | null {
  const trimmed = predicate.trim();
  if (trimmed === "") return null;

  const m = trimmed.match(/^(>=|<=|<>|!=|>|<|=)\s*(.+)$/);
  if (m) {
    const op = m[1] === "!=" ? "<>" : m[1];
    const rhs = m[2].trim();
    const asNumber = Number(rhs);
    const rhsExpr = rhs !== "" && Number.isFinite(asNumber)
      ? rhs
      : `"${rhs.replace(/"/g, '""')}"`;
    return `value ${op} ${rhsExpr}`;
  }

  return trimmed;
}

function filterByMask(data: ParsedChartData, keep: boolean[]): ParsedChartData {
  const categories = data.categories.filter((_, i) => keep[i]);
  const series = data.series.map((s) => ({
    ...s,
    values: s.values.filter((_, i) => keep[i]),
  }));
  return { categories, series };
}

// ============================================================================
// Sort
// ============================================================================

function applySort(
  data: ParsedChartData,
  t: SortTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
): ParsedChartData {
  const { field, order = "asc" } = t;
  const n = data.categories.length;
  if (n === 0) return data;

  const indices = Array.from({ length: n }, (_, i) => i);
  const seriesIdx = field === "$category" ? -1 : findSeriesIndex(data, field);

  if (field !== "$category" && seriesIdx < 0) {
    report(diagnostics, index, "sort", "warning", `Sort: unknown field "${field}" — order unchanged.`);
    return data;
  }

  indices.sort((a, b) => {
    let cmp: number;
    if (field === "$category") {
      cmp = data.categories[a].localeCompare(data.categories[b]);
    } else {
      cmp = (data.series[seriesIdx].values[a] ?? 0) - (data.series[seriesIdx].values[b] ?? 0);
    }
    return order === "desc" ? -cmp : cmp;
  });

  return reorderByIndices(data, indices);
}

function reorderByIndices(data: ParsedChartData, indices: number[]): ParsedChartData {
  const categories = indices.map((i) => data.categories[i]);
  const series = data.series.map((s) => ({
    ...s,
    values: indices.map((i) => s.values[i]),
  }));
  return { categories, series };
}

// ============================================================================
// Aggregate
// ============================================================================

function applyAggregate(
  data: ParsedChartData,
  t: AggregateTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
): ParsedChartData {
  const { groupBy, op, field, as } = t;
  const seriesIdx = findSeriesIndex(data, field);
  if (seriesIdx < 0) {
    report(diagnostics, index, "aggregate", "warning", `Aggregate: unknown field "${field}" — transform skipped.`);
    return data;
  }

  // Warn about any groupBy field that doesn't exist (it is silently ignored).
  for (const gb of groupBy) {
    if (gb !== "$category" && findSeriesIndex(data, gb) < 0) {
      report(diagnostics, index, "aggregate", "warning", `Aggregate: unknown groupBy field "${gb}" — ignored.`);
    }
  }

  // Group by category labels (for now, groupBy always operates on categories)
  const groups = new Map<string, number[]>();

  for (let ci = 0; ci < data.categories.length; ci++) {
    // Build group key from groupBy fields
    const keyParts: string[] = [];
    for (const gb of groupBy) {
      if (gb === "$category") {
        keyParts.push(data.categories[ci]);
      } else {
        const gbIdx = findSeriesIndex(data, gb);
        if (gbIdx >= 0) {
          keyParts.push(String(data.series[gbIdx].values[ci]));
        }
      }
    }
    const key = keyParts.join("|||");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(ci);
  }

  const newCategories: string[] = [];
  const newValues: number[] = [];

  for (const [key, indices] of groups) {
    // Use the first part of the key as category name (split back)
    newCategories.push(key.split("|||")[0]);
    const values = indices.map((i) => data.series[seriesIdx].values[i]);
    newValues.push(computeAggregate(op, values));
  }

  return {
    categories: newCategories,
    series: [{
      name: as,
      values: newValues,
      color: data.series[seriesIdx].color,
    }],
  };
}

function computeAggregate(op: AggregateOp, values: number[]): number {
  if (values.length === 0) return 0;
  switch (op) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "mean":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "median": {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    }
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "count":
      return values.length;
    default:
      return 0;
  }
}

// ============================================================================
// Calculate
// ============================================================================

function applyCalculate(
  data: ParsedChartData,
  t: CalculateTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
): ParsedChartData {
  const { expr, as } = t;

  // Compile once, evaluate per row against that row's scope.
  let compiled: CompiledFormula | null = null;
  try {
    compiled = compileFormula(expr);
  } catch (err) {
    report(diagnostics, index, "calculate", "error", `Calculate "${as}": invalid expression — ${errMessage(err)}. Values set to 0.`);
    compiled = null;
  }

  const sanitized = sanitizeNames(data);
  let errorCount = 0;
  let firstError = "";
  const newValues: number[] = data.categories.map((_, ci) => {
    if (!compiled) return 0;
    const scope = buildRowScope(data, sanitized, ci);
    try {
      const num = toNumber(compiled(scope));
      return Number.isFinite(num) ? num : 0;
    } catch (err) {
      // Non-numeric result or evaluation error — fall back to 0.
      errorCount++;
      if (!firstError) firstError = errMessage(err);
      return 0;
    }
  });

  if (errorCount > 0) {
    report(diagnostics, index, "calculate", "warning",
      `Calculate "${as}": ${errorCount} of ${newValues.length} rows could not be evaluated (set to 0) — ${firstError}.`);
  }

  // Check if a series with this name already exists — replace it
  const existingIdx = data.series.findIndex((s) => s.name === as);
  if (existingIdx >= 0) {
    const series = data.series.map((s, i) =>
      i === existingIdx ? { ...s, values: newValues } : s,
    );
    return { categories: data.categories, series };
  }

  return {
    categories: data.categories,
    series: [
      ...data.series,
      { name: as, values: newValues, color: null },
    ],
  };
}

// ============================================================================
// Window
// ============================================================================

function applyWindow(
  data: ParsedChartData,
  t: WindowTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
): ParsedChartData {
  const { op, field, as } = t;
  const seriesIdx = findSeriesIndex(data, field);
  if (seriesIdx < 0) {
    report(diagnostics, index, "window", "warning", `Window: unknown field "${field}" — transform skipped.`);
    return data;
  }

  const srcValues = data.series[seriesIdx].values;
  const newValues: number[] = [];

  switch (op) {
    case "running_sum": {
      let sum = 0;
      for (const v of srcValues) {
        sum += v;
        newValues.push(sum);
      }
      break;
    }
    case "running_mean": {
      let sum = 0;
      for (let i = 0; i < srcValues.length; i++) {
        sum += srcValues[i];
        newValues.push(sum / (i + 1));
      }
      break;
    }
    case "rank": {
      // Rank by value descending (highest = rank 1)
      const indexed = srcValues.map((v, i) => ({ v, i }));
      indexed.sort((a, b) => b.v - a.v);
      const ranks = new Array<number>(srcValues.length);
      indexed.forEach((item, rank) => {
        ranks[item.i] = rank + 1;
      });
      newValues.push(...ranks);
      break;
    }
  }

  // Check if a series with this name already exists — replace it
  const existingIdx = data.series.findIndex((s) => s.name === as);
  if (existingIdx >= 0) {
    const series = data.series.map((s, i) =>
      i === existingIdx ? { ...s, values: newValues } : s,
    );
    return { categories: data.categories, series };
  }

  return {
    categories: data.categories,
    series: [
      ...data.series,
      { name: as, values: newValues, color: null },
    ],
  };
}

// ============================================================================
// Bin
// ============================================================================

function applyBin(
  data: ParsedChartData,
  t: BinTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
): ParsedChartData {
  const { field, binCount = 10, as } = t;
  const seriesIdx = findSeriesIndex(data, field);
  if (seriesIdx < 0) {
    report(diagnostics, index, "bin", "warning", `Bin: unknown field "${field}" — transform skipped.`);
    return data;
  }

  const srcValues = data.series[seriesIdx].values;
  if (srcValues.length === 0) return data;

  const min = Math.min(...srcValues);
  const max = Math.max(...srcValues);
  const range = max - min || 1;
  const binWidth = range / binCount;

  // Create bins
  const bins: number[][] = Array.from({ length: binCount }, () => []);
  for (const v of srcValues) {
    let binIdx = Math.floor((v - min) / binWidth);
    if (binIdx >= binCount) binIdx = binCount - 1; // clamp max value
    if (binIdx < 0) binIdx = 0;
    bins[binIdx].push(v);
  }

  // Build output: categories are bin labels, values are counts
  const categories: string[] = [];
  const counts: number[] = [];

  for (let i = 0; i < binCount; i++) {
    const lo = min + i * binWidth;
    const hi = lo + binWidth;
    categories.push(`${formatBinEdge(lo)}–${formatBinEdge(hi)}`);
    counts.push(bins[i].length);
  }

  return {
    categories,
    series: [{
      name: as,
      values: counts,
      color: data.series[seriesIdx].color,
    }],
  };
}

function formatBinEdge(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ============================================================================
// Helpers
// ============================================================================

function findSeriesIndex(data: ParsedChartData, name: string): number {
  return data.series.findIndex((s) => s.name === name);
}

/** Underscore form of each series name (so "Revenue Total" is usable as Revenue_Total). */
function sanitizeNames(data: ParsedChartData): string[] {
  return data.series.map((s) => s.name.replace(/\s+/g, "_"));
}

/**
 * Build the formula scope for one row: every series value (by exact name — use
 * [brackets] for names with spaces — and by underscore form), the built-ins
 * $index and $category, and, for filters, the field's value as `value`/`$value`.
 * Built-ins are set last so they win over any same-named series.
 */
function buildRowScope(
  data: ParsedChartData,
  sanitized: string[],
  ci: number,
  fieldValue?: FormulaValue,
): FormulaScope {
  const scope: FormulaScope = new Map();
  for (let si = 0; si < data.series.length; si++) {
    const v = data.series[si].values[ci] ?? 0;
    scope.set(data.series[si].name, v);
    scope.set(sanitized[si], v);
  }
  scope.set("$index", ci);
  scope.set("$category", data.categories[ci] ?? "");
  if (fieldValue !== undefined) {
    scope.set("value", fieldValue);
    scope.set("$value", fieldValue);
  }
  return scope;
}
