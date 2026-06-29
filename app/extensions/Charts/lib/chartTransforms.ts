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
  LookupTransform,
  PivotTransform,
  TidyData,
  AggregateOp,
} from "../types";
import {
  translateChartExpr,
  toEngineScope,
  isEngineError,
  resultToBoolean,
  resultToNumber,
  type FormulaScope,
  type FormulaValue,
} from "./chartFormula";
import { parseDisplayNumber } from "./chartFieldTypes";
import { getChartTransform } from "@api/chartTransforms";
import { evaluateScoped, type EvalScope, type EvalResultValue } from "@api/formulaEval";

// ============================================================================
// Public API
// ============================================================================

/**
 * Apply a sequence of transforms to parsed chart data. Async because "filter"
 * and "calculate" evaluate their expressions via the real Rust engine
 * (evaluate_scoped, A6). This is a convenience wrapper over
 * {@link applyTransformsAsync} with a no-op sandbox runner (so it does NOT run
 * sandboxed custom transforms — the same limit the old synchronous variant had).
 * The two live render paths call applyTransformsAsync directly with the real
 * runner; this wrapper is for callers that don't supply one.
 */
export function applyTransforms(
  data: ParsedChartData,
  transforms: TransformSpec[],
  diagnostics?: TransformDiagnostic[],
  lookupData?: Map<number, ParsedChartData>,
  tidyData?: TidyData,
  params?: ReadonlyMap<string, FormulaValue>,
): Promise<ParsedChartData> {
  return applyTransformsAsync(data, transforms, () => null, diagnostics, lookupData, tidyData, params);
}

/**
 * Deep shape guard: `out` is usable ParsedChartData — `categories[]` AND every
 * series element `{ name:string, values[] }`. A downstream built-in/painter indexes
 * `s.values` directly, so a malformed return must be rejected BEFORE it flows on
 * (the throw would otherwise land OUTSIDE this pipeline step and crash the render).
 */
export function isValidParsedChartData(out: unknown): out is ParsedChartData {
  const o = out as ParsedChartData | null;
  return (
    o != null &&
    Array.isArray(o.categories) &&
    Array.isArray(o.series) &&
    o.series.every((s) => s != null && typeof s.name === "string" && Array.isArray(s.values))
  );
}

/**
 * Runs a SANDBOXED transform whose body lives in a worker realm, returning a
 * Promise of the transformed data — or `null` when `type` is not a mounted sandbox
 * transform (the pipeline then handles that step synchronously). Supplied by the
 * reader so chartTransforms.ts stays free of the @api script-host surface.
 */
export type SandboxTransformRunner = (
  type: string,
  data: ParsedChartData,
  transform: TransformSpec,
  params: ReadonlyMap<string, FormulaValue> | undefined,
) => Promise<ParsedChartData> | null;

/**
 * Async variant of {@link applyTransforms} that awaits SANDBOXED custom transforms
 * IN PIPELINE ORDER. For each step the `runner` is consulted first: a returned
 * Promise means the step is a sandbox transform (awaited, validated, its output
 * flows on); `null` means the step runs synchronously via the same applyOne
 * dispatch as {@link applyTransforms} (built-ins + the in-process custom registry).
 * A sandbox throw or malformed return degrades to a diagnostic + the UNCHANGED
 * input data (never crashes the render) — and crucially, awaiting in order means a
 * `[builtin, sandbox]` pipeline feeds the builtin's OUTPUT to the sandbox step
 * (pre-resolving against raw data would silently discard the earlier step).
 */
export async function applyTransformsAsync(
  data: ParsedChartData,
  transforms: TransformSpec[],
  runner: SandboxTransformRunner,
  diagnostics?: TransformDiagnostic[],
  lookupData?: Map<number, ParsedChartData>,
  tidyData?: TidyData,
  params?: ReadonlyMap<string, FormulaValue>,
): Promise<ParsedChartData> {
  let d = data;
  for (let i = 0; i < transforms.length; i++) {
    const t = transforms[i];
    const type = (t as { type?: string }).type ?? "unknown";
    const pending = runner(type, d, t, params);
    if (!pending) {
      // filter/calculate evaluate expressions via the real Rust engine (async
      // IPC, A6); the remaining built-ins + the in-process custom registry are
      // synchronous and go through applyOne.
      if (t.type === "filter") {
        d = await applyFilter(d, t, i, diagnostics, params);
      } else if (t.type === "calculate") {
        d = await applyCalculate(d, t, i, diagnostics, params);
      } else {
        d = applyOne(d, t, i, diagnostics, lookupData, tidyData, params);
      }
      continue;
    }
    try {
      const out = await pending;
      if (isValidParsedChartData(out)) {
        d = out;
      } else {
        report(diagnostics, i, type as TransformSpec["type"], "error", `Sandbox transform "${type}" returned invalid chart data.`);
      }
    } catch (e) {
      report(diagnostics, i, type as TransformSpec["type"], "error", `Sandbox transform "${type}" failed: ${errMessage(e)}`);
    }
  }
  return d;
}

// ============================================================================
// Dispatcher
// ============================================================================

function applyOne(
  data: ParsedChartData,
  transform: TransformSpec,
  index: number,
  diagnostics?: TransformDiagnostic[],
  lookupData?: Map<number, ParsedChartData>,
  tidyData?: TidyData,
  params?: ReadonlyMap<string, FormulaValue>,
): ParsedChartData {
  switch (transform.type) {
    // NOTE: "filter" and "calculate" evaluate expressions via the real engine
    // (async) and are handled in applyTransformsAsync, never here.
    case "sort":
      return applySort(data, transform, index, diagnostics);
    case "aggregate":
      return applyAggregate(data, transform, index, diagnostics);
    case "window":
      return applyWindow(data, transform, index, diagnostics);
    case "bin":
      return applyBin(data, transform, index, diagnostics);
    case "lookup":
      return applyLookup(data, transform, index, diagnostics, lookupData);
    case "pivot":
      return applyPivot(data, transform, index, diagnostics, tidyData);
    default: {
      const unknownType = (transform as { type?: string }).type ?? "unknown";
      // Not a built-in — consult the custom-transform registry (the dogfooding
      // extension point). A registered transform runs sandboxed-by-contract as a
      // pure data->data function; a throw or a malformed return degrades to a
      // diagnostic + the input data (never crashes the pipeline).
      const custom = getChartTransform(unknownType);
      if (custom) {
        try {
          const out = custom.apply(data, transform, { params }) as ParsedChartData;
          // Deep shape guard (see isValidParsedChartData) — a malformed return must
          // be rejected here, else a downstream s.values index would throw OUTSIDE
          // this try/catch and crash the whole render.
          if (isValidParsedChartData(out)) {
            return out;
          }
          diagnostics?.push({
            index,
            transformType: unknownType,
            severity: "error",
            message: `Custom transform "${unknownType}" returned invalid chart data.`,
          });
          return data;
        } catch (e) {
          diagnostics?.push({
            index,
            transformType: unknownType,
            severity: "error",
            message: `Custom transform "${unknownType}" failed: ${e instanceof Error ? e.message : String(e)}`,
          });
          return data;
        }
      }
      diagnostics?.push({
        index,
        transformType: unknownType,
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

async function applyFilter(
  data: ParsedChartData,
  t: FilterTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
  params?: ReadonlyMap<string, FormulaValue>,
): Promise<ParsedChartData> {
  const { field, predicate } = t;

  const seriesIdx = field === "$category" ? -1 : findSeriesIndex(data, field);
  if (field !== "$category" && seriesIdx < 0) {
    report(diagnostics, index, "filter", "warning", `Filter: unknown field "${field}" — no rows removed.`);
    return data;
  }

  const exprSrc = predicateToExpr(predicate);
  if (exprSrc === null) return data; // Empty predicate: intentional no-op.
  if (data.categories.length === 0) return data;

  // Translate the chart predicate into engine syntax (variable refs → aliases).
  let engineExpr: string;
  try {
    engineExpr = translateChartExpr(exprSrc);
  } catch (err) {
    // Unparseable predicate — leave the data untouched rather than dropping rows.
    report(diagnostics, index, "filter", "warning", `Filter: invalid predicate ${JSON.stringify(predicate)} — ${errMessage(err)}. No rows removed.`);
    return data;
  }

  // ONE engine call: parse-once, evaluate per row (scope) in the real engine.
  const sanitized = sanitizeNames(data);
  const scopes: EvalScope[] = data.categories.map((cat, ci) => {
    const fieldVal: FormulaValue = field === "$category"
      ? cat
      : (data.series[seriesIdx].values[ci] ?? 0);
    return toEngineScope(buildRowScope(data, sanitized, ci, fieldVal, params));
  });

  let results: EvalResultValue[];
  try {
    results = await evaluateScoped(engineExpr, scopes);
  } catch (err) {
    // Whole-expression (syntax) failure — leave the data untouched.
    report(diagnostics, index, "filter", "warning", `Filter: invalid predicate ${JSON.stringify(predicate)} — ${errMessage(err)}. No rows removed.`);
    return data;
  }

  let errorCount = 0;
  let firstError = "";
  const keep: boolean[] = data.categories.map((_, ci) => {
    const r = results[ci];
    // A row whose predicate errors (unknown name, bad coercion, missing result)
    // is KEPT — filtering must never silently drop data on a broken expression.
    if (r === undefined || isEngineError(r)) {
      errorCount++;
      if (!firstError) firstError = r === undefined ? "no result" : String(r);
      return true;
    }
    try {
      return resultToBoolean(r);
    } catch (err) {
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

  // Warn about any groupBy field that doesn't exist (it is silently ignored).
  for (const gb of groupBy) {
    if (gb !== "$category" && findSeriesIndex(data, gb) < 0) {
      report(diagnostics, index, "aggregate", "warning", `Aggregate: unknown groupBy field "${gb}" — ignored.`);
    }
  }

  // Group row indices by the groupBy key (category by default).
  const groups = new Map<string, number[]>();
  for (let ci = 0; ci < data.categories.length; ci++) {
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

  const groupEntries = [...groups];
  // Use the first part of the key as the category name (split back).
  const newCategories = groupEntries.map(([key]) => key.split("|||")[0]);

  // Multi-series mode: aggregate EVERY series per group, preserving all series.
  if (field === undefined || field === "*") {
    if (data.series.length === 0) return data;
    const series = data.series.map((s) => ({
      name: s.name,
      color: s.color,
      values: groupEntries.map(([, idxs]) => computeAggregate(op, idxs.map((i) => s.values[i]))),
    }));
    return { categories: newCategories, series };
  }

  // Single-series mode: aggregate the named field into one output series.
  const seriesIdx = findSeriesIndex(data, field);
  if (seriesIdx < 0) {
    report(diagnostics, index, "aggregate", "warning", `Aggregate: unknown field "${field}" — transform skipped.`);
    return data;
  }

  const values = groupEntries.map(([, idxs]) => computeAggregate(op, idxs.map((i) => data.series[seriesIdx].values[i])));
  return {
    categories: newCategories,
    series: [{
      name: as ?? field,
      values,
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

async function applyCalculate(
  data: ParsedChartData,
  t: CalculateTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
  params?: ReadonlyMap<string, FormulaValue>,
): Promise<ParsedChartData> {
  const { expr, as } = t;

  // Translate to engine syntax (variable refs → aliases).
  let engineExpr: string | null = null;
  try {
    engineExpr = translateChartExpr(expr);
  } catch (err) {
    report(diagnostics, index, "calculate", "error", `Calculate "${as}": invalid expression — ${errMessage(err)}. Values set to 0.`);
    engineExpr = null;
  }

  let newValues: number[];
  if (engineExpr === null || data.categories.length === 0) {
    // Invalid expression (or no rows): every value falls back to 0 (matching the
    // old compiled===null behavior); an empty data set yields an empty series.
    newValues = data.categories.map(() => 0);
  } else {
    const sanitized = sanitizeNames(data);
    const scopes: EvalScope[] = data.categories.map((_, ci) =>
      toEngineScope(buildRowScope(data, sanitized, ci, undefined, params)),
    );
    let results: EvalResultValue[] | null = null;
    try {
      results = await evaluateScoped(engineExpr, scopes); // ONE engine call, parse-once
    } catch (err) {
      report(diagnostics, index, "calculate", "error", `Calculate "${as}": invalid expression — ${errMessage(err)}. Values set to 0.`);
      results = null;
    }
    if (results === null) {
      newValues = data.categories.map(() => 0);
    } else {
      let errorCount = 0;
      let firstError = "";
      newValues = data.categories.map((_, ci) => {
        const r = results![ci];
        if (r === undefined || isEngineError(r)) {
          errorCount++;
          if (!firstError) firstError = r === undefined ? "no result" : String(r);
          return 0;
        }
        try {
          return resultToNumber(r); // non-finite → 0, like the old toNumber path
        } catch (err) {
          errorCount++;
          if (!firstError) firstError = errMessage(err);
          return 0;
        }
      });
      if (errorCount > 0) {
        report(diagnostics, index, "calculate", "warning",
          `Calculate "${as}": ${errorCount} of ${newValues.length} rows could not be evaluated (set to 0) — ${firstError}.`);
      }
    }
  }

  return replaceOrAppendSeries(data, as, newValues);
}

/** Replace the same-named series in place, or append a new one. */
function replaceOrAppendSeries(data: ParsedChartData, as: string, newValues: number[]): ParsedChartData {
  const existingIdx = data.series.findIndex((s) => s.name === as);
  if (existingIdx >= 0) {
    const series = data.series.map((s, i) =>
      i === existingIdx ? { ...s, values: newValues } : s,
    );
    return { categories: data.categories, series };
  }
  return {
    categories: data.categories,
    series: [...data.series, { name: as, values: newValues, color: null }],
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
// Lookup (join a second data source by category)
// ============================================================================

function applyLookup(
  data: ParsedChartData,
  t: LookupTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
  lookupData?: Map<number, ParsedChartData>,
): ParsedChartData {
  // The secondary source is resolved+read asynchronously before the (sync)
  // pipeline runs and supplied here keyed by transform index.
  const resolved = lookupData?.get(index);
  if (!resolved) {
    report(diagnostics, index, "lookup", "warning", "Lookup: secondary data could not be loaded — no series added.");
    return data;
  }

  // Map each secondary category label to its row (first occurrence wins).
  const secByCategory = new Map<string, number>();
  resolved.categories.forEach((c, i) => {
    if (!secByCategory.has(c)) secByCategory.set(c, i);
  });

  const wanted = t.fields && t.fields.length > 0
    ? resolved.series.filter((s) => t.fields!.includes(s.name))
    : resolved.series;

  if (wanted.length === 0) {
    report(diagnostics, index, "lookup", "warning", "Lookup: no matching fields found in the secondary source.");
    return data;
  }

  const matchedCategories = data.categories.filter((c) => secByCategory.has(c)).length;
  if (matchedCategories === 0) {
    report(diagnostics, index, "lookup", "warning", "Lookup: no categories matched the secondary source.");
  }

  const def = t.default ?? 0;
  const added = wanted.map((s) => ({
    name: s.name,
    color: s.color,
    values: data.categories.map((cat) => {
      const i = secByCategory.get(cat);
      return i === undefined ? def : (s.values[i] ?? def);
    }),
  }));

  // Merge into the existing series, replacing any with the same name.
  const series = [...data.series];
  for (const a of added) {
    const existingIdx = series.findIndex((s) => s.name === a.name);
    if (existingIdx >= 0) series[existingIdx] = a;
    else series.push(a);
  }

  return { categories: data.categories, series };
}

// ============================================================================
// Pivot (long -> wide reshape of the source)
// ============================================================================

function applyPivot(
  data: ParsedChartData,
  t: PivotTransform,
  index: number,
  diagnostics?: TransformDiagnostic[],
  tidyData?: TidyData,
): ParsedChartData {
  if (!tidyData) {
    report(diagnostics, index, "pivot", "warning", "Pivot: requires a cell-range data source — left unchanged.");
    return data;
  }

  const catField = tidyData.fields.find((f) => f.name === t.category);
  const keyField = tidyData.fields.find((f) => f.name === t.key);
  const valField = tidyData.fields.find((f) => f.name === t.value);

  const missing: string[] = [];
  if (!catField) missing.push(t.category);
  if (!keyField) missing.push(t.key);
  if (!valField) missing.push(t.value);
  if (!catField || !keyField || !valField) {
    report(diagnostics, index, "pivot", "warning", `Pivot: unknown column(s): ${missing.join(", ")} — left unchanged.`);
    return data;
  }

  const op = t.op ?? "sum";
  const rowCount = Math.min(catField.values.length, keyField.values.length, valField.values.length);

  const categories: string[] = [];
  const catIndex = new Map<string, number>();
  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  // grouped[categoryIndex][keyIndex] = the numeric values to aggregate.
  const grouped: number[][][] = [];

  for (let r = 0; r < rowCount; r++) {
    const cat = catField.values[r] ?? "";
    const key = keyField.values[r] ?? "";
    const num = parseDisplayNumber(valField.values[r] ?? "");

    let ci = catIndex.get(cat);
    if (ci === undefined) {
      ci = categories.length;
      catIndex.set(cat, ci);
      categories.push(cat);
      grouped.push([]);
    }
    let ki = keyIndex.get(key);
    if (ki === undefined) {
      ki = keys.length;
      keyIndex.set(key, ki);
      keys.push(key);
    }
    if (!grouped[ci][ki]) grouped[ci][ki] = [];
    if (!Number.isNaN(num)) grouped[ci][ki].push(num);
  }

  const series = keys.map((name, ki) => ({
    name,
    color: null,
    values: categories.map((_, ci) => computeAggregate(op, grouped[ci][ki] ?? [])),
  }));

  return { categories, series };
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
 * Build the formula scope for one row: named params (referenced as [Name]), every
 * series value (by exact name — use [brackets] for names with spaces — and by
 * underscore form), the built-ins $index and $category, and, for filters, the
 * field's value as `value`/`$value`. Precedence is built-ins > series > params:
 * params are written FIRST so a real series (and a built-in) always wins over a
 * same-named param — a param can only fill a name nothing else uses.
 */
function buildRowScope(
  data: ParsedChartData,
  sanitized: string[],
  ci: number,
  fieldValue?: FormulaValue,
  params?: ReadonlyMap<string, FormulaValue>,
): FormulaScope {
  const scope: FormulaScope = new Map();
  if (params) {
    for (const [name, value] of params) scope.set(name, value);
  }
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
