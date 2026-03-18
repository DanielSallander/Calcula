//! FILENAME: app/extensions/Charts/lib/chartTransforms.ts
// PURPOSE: Pure functional data transform pipeline for chart data.
// CONTEXT: Applied after parsing raw cell data, before rendering.
//          Each transform is a pure function: ParsedChartData → ParsedChartData.

import type {
  ParsedChartData,
  TransformSpec,
  FilterTransform,
  SortTransform,
  AggregateTransform,
  CalculateTransform,
  WindowTransform,
  BinTransform,
  AggregateOp,
} from "../types";

// ============================================================================
// Public API
// ============================================================================

/**
 * Apply a sequence of transforms to parsed chart data.
 * Each transform is pure — returns a new ParsedChartData without mutating the input.
 */
export function applyTransforms(
  data: ParsedChartData,
  transforms: TransformSpec[],
): ParsedChartData {
  return transforms.reduce((d, t) => applyOne(d, t), data);
}

// ============================================================================
// Dispatcher
// ============================================================================

function applyOne(data: ParsedChartData, transform: TransformSpec): ParsedChartData {
  switch (transform.type) {
    case "filter":
      return applyFilter(data, transform);
    case "sort":
      return applySort(data, transform);
    case "aggregate":
      return applyAggregate(data, transform);
    case "calculate":
      return applyCalculate(data, transform);
    case "window":
      return applyWindow(data, transform);
    case "bin":
      return applyBin(data, transform);
    default:
      return data;
  }
}

// ============================================================================
// Filter
// ============================================================================

function applyFilter(data: ParsedChartData, t: FilterTransform): ParsedChartData {
  const { field, predicate } = t;
  const parsed = parsePredicate(predicate);
  if (!parsed) return data;

  const seriesIdx = field === "$category" ? -1 : findSeriesIndex(data, field);
  if (field !== "$category" && seriesIdx < 0) return data;

  // Build index mask of rows to keep
  const keep: boolean[] = data.categories.map((cat, ci) => {
    if (field === "$category") {
      return evaluatePredicate(parsed, cat);
    }
    return evaluatePredicate(parsed, data.series[seriesIdx].values[ci]);
  });

  return filterByMask(data, keep);
}

interface ParsedPredicate {
  op: string;
  value: string;
}

function parsePredicate(pred: string): ParsedPredicate | null {
  const trimmed = pred.trim();
  // Match operators: >=, <=, !=, >, <, =
  const match = trimmed.match(/^(>=|<=|!=|>|<|=)\s*(.+)$/);
  if (!match) return null;
  return { op: match[1], value: match[2].trim() };
}

function evaluatePredicate(pred: ParsedPredicate, actual: string | number): boolean {
  const numActual = typeof actual === "number" ? actual : parseFloat(actual as string);
  const numTarget = parseFloat(pred.value);
  const isNumeric = !isNaN(numActual) && !isNaN(numTarget);

  switch (pred.op) {
    case ">":
      return isNumeric && numActual > numTarget;
    case "<":
      return isNumeric && numActual < numTarget;
    case ">=":
      return isNumeric && numActual >= numTarget;
    case "<=":
      return isNumeric && numActual <= numTarget;
    case "=":
      return isNumeric ? numActual === numTarget : String(actual) === pred.value;
    case "!=":
      return isNumeric ? numActual !== numTarget : String(actual) !== pred.value;
    default:
      return true;
  }
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

function applySort(data: ParsedChartData, t: SortTransform): ParsedChartData {
  const { field, order = "asc" } = t;
  const n = data.categories.length;
  if (n === 0) return data;

  const indices = Array.from({ length: n }, (_, i) => i);
  const seriesIdx = field === "$category" ? -1 : findSeriesIndex(data, field);

  if (field !== "$category" && seriesIdx < 0) return data;

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

function applyAggregate(data: ParsedChartData, t: AggregateTransform): ParsedChartData {
  const { groupBy, op, field, as } = t;
  const seriesIdx = findSeriesIndex(data, field);
  if (seriesIdx < 0) return data;

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

function applyCalculate(data: ParsedChartData, t: CalculateTransform): ParsedChartData {
  const { expr, as } = t;
  const newValues: number[] = [];

  // Build variable name → series index mapping
  const varMap = new Map<string, number>();
  for (let si = 0; si < data.series.length; si++) {
    // Store both original name and sanitized name (spaces → underscores)
    varMap.set(data.series[si].name, si);
    const sanitized = data.series[si].name.replace(/\s+/g, "_");
    if (sanitized !== data.series[si].name) {
      varMap.set(sanitized, si);
    }
  }

  for (let ci = 0; ci < data.categories.length; ci++) {
    const result = evaluateExpression(expr, data, ci, varMap);
    newValues.push(result);
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

function evaluateExpression(
  expr: string,
  data: ParsedChartData,
  ci: number,
  varMap: Map<string, number>,
): number {
  // Replace variable references with their numeric values
  // Sort by name length descending to avoid partial matches (e.g., "Revenue Total" before "Revenue")
  let resolved = expr;
  const names = [...varMap.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const [name, si] of names) {
    // Use word boundary-aware replacement
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "g");
    resolved = resolved.replace(re, String(data.series[si].values[ci] ?? 0));
  }

  // Replace built-in variables
  resolved = resolved.replace(/\$index/g, String(ci));
  resolved = resolved.replace(/\$category/g, `"${data.categories[ci]}"`);

  // Evaluate the expression safely using Function constructor
  // Only allow numeric operations — no access to globals
  try {
    // Validate: only allow digits, operators, parentheses, decimal points, spaces, minus
    const sanitized = resolved.replace(/"[^"]*"/g, "0"); // Replace string literals for validation
    if (!/^[\d\s+\-*/().e]+$/i.test(sanitized)) {
      return 0;
    }
    const fn = new Function(`"use strict"; return (${resolved});`);
    const result = fn();
    return typeof result === "number" && isFinite(result) ? result : 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// Window
// ============================================================================

function applyWindow(data: ParsedChartData, t: WindowTransform): ParsedChartData {
  const { op, field, as } = t;
  const seriesIdx = findSeriesIndex(data, field);
  if (seriesIdx < 0) return data;

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

function applyBin(data: ParsedChartData, t: BinTransform): ParsedChartData {
  const { field, binCount = 10, as } = t;
  const seriesIdx = findSeriesIndex(data, field);
  if (seriesIdx < 0) return data;

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
