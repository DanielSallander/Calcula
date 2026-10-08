//! FILENAME: app/extensions/Charts/lib/pivotChartDataReader.ts
// PURPOSE: Read pivot table aggregated data and convert it to ParsedChartData.
// CONTEXT: PivotCharts use the pivot table's output (PivotViewResponse) as their
//          data source instead of reading from a cell range. This module bridges
//          the pivot view data into the chart rendering pipeline.

import { pivot } from "@api/pivot";
import type {
  PivotViewResponse,
  PivotRowData,
  PivotCellData,
  PivotColumnData,
} from "@api/pivot";
import type { ParsedChartData, PivotDataSource, ChartSeries, PivotChartFieldInfo, DatumKind, SeriesTotal } from "../types";

// ============================================================================
// Public API
// ============================================================================

/**
 * Read data from a pivot table and return it as ParsedChartData ready for
 * chart rendering.
 *
 * The conversion works as follows:
 * - **Categories** come from the row labels (row header cells).
 * - **Series** come from the column headers (one series per data column).
 * - **Values** come from the data cells.
 *
 * For pivot tables with multiple row fields, the labels are joined with " > "
 * to create a flat category list (e.g., "2024 > Q1 > January").
 */
export async function readPivotChartData(
  source: PivotDataSource,
): Promise<ParsedChartData> {
  const view = await pivot.getView(source.pivotId);
  if (!view) {
    return { categories: [], series: [] };
  }
  return extractChartData(view, source);
}

/**
 * Auto-detect chart series from a pivot table's current view.
 * Returns suggested series definitions and category configuration.
 */
export async function autoDetectPivotSeries(
  pivotId: string,
): Promise<{
  series: ChartSeries[];
  title: string | null;
}> {
  const view = await pivot.getView(pivotId);
  if (!view) {
    return { series: [], title: null };
  }

  const columnNames = extractColumnNames(view);
  const series: ChartSeries[] = columnNames.map((name, idx) => ({
    name,
    sourceIndex: idx,
    color: null,
  }));

  // Use the pivot table name as chart title if available
  let title: string | null = null;
  try {
    const info = await pivot.getInfo(pivotId);
    if (info && info.name) {
      title = info.name;
    }
  } catch {
    // Info not available, that's fine
  }

  return { series, title };
}

// ============================================================================
// Internal: Data Extraction
// ============================================================================

/**
 * Extract chart-ready data from a PivotViewResponse.
 *
 * Layout of a pivot view:
 * ```
 * [Filter rows]          ← filterRowCount rows at top (skipped)
 * [Column headers]       ← columnHeaderRowCount rows (series names)
 * [Data rows]            ← actual data (categories + values)
 *   ├─ [Row labels]      ← first rowLabelColCount columns
 *   └─ [Data cells]      ← remaining columns (numeric values)
 * [Subtotal rows]        ← optional (included if source.includeSubtotals)
 * [Grand total row]      ← optional (included if source.includeGrandTotal)
 * ```
 */
export function extractChartData(
  view: PivotViewResponse,
  source: { includeSubtotals?: boolean; includeGrandTotal?: boolean },
): ParsedChartData {
  const { rowLabelColCount, columnHeaderRowCount, filterRowCount } = view;
  const includeSubtotals = source.includeSubtotals ?? false;
  // A pivot with NO row fields has no Data rows at all: its one row of numbers
  // is the GRAND TOTAL (the engine emits a single GrandTotal row). Dropping it
  // left such a chart with nothing to draw — and a measure-only pivot is
  // exactly what a Card or a Gauge is pointed at ("Sum of Sales"). So when
  // there is nothing else to show, the grand total IS the data. With row
  // fields the opt-in stays as it was. The design-query reader calls this same
  // function, so a measure-only design query gets the same rule.
  const hasDataRows = view.rows.some((r) => r.rowType === "Data" && r.visible);
  const includeGrandTotal = source.includeGrandTotal ?? !hasDataRows;

  // Identify data columns (columns after the row label columns)
  const dataColumns = view.columns.filter(
    (col) => col.colType === "Data" || col.colType === "Subtotal" || col.colType === "GrandTotal",
  );

  // Extract column/series names from the column header rows
  const columnNames = extractColumnNames(view);

  // Build series arrays (one per data column), each with the text the pivot
  // SHOWS for its cells (ParsedChartData.displayValues: a Card keeps the
  // pivot's number format, and a text cell is never charted as its 0).
  const seriesMap: Map<number, { name: string; values: number[]; texts: string[]; kinds: DatumKind[] }> = new Map();
  for (let i = 0; i < dataColumns.length; i++) {
    seriesMap.set(dataColumns[i].viewCol, {
      name: columnNames[i] ?? `Value ${i + 1}`,
      values: [],
      texts: [],
      kinds: [],
    });
  }

  // The source's own total of each series (ParsedChartData.seriesTotals): the
  // GRAND TOTAL row when it is shown but not charted. A Card over an average
  // or a distinct count must show this, never the sum of the rows above it.
  let seriesTotals: Array<SeriesTotal | null> | undefined;
  if (!includeGrandTotal) {
    const totalRow = view.rows.find((r) => r.rowType === "GrandTotal" && r.visible);
    if (totalRow) {
      seriesTotals = [...seriesMap.keys()].map((viewCol) => {
        const cell = totalRow.cells[viewCol];
        if (!cell) return null;
        return { value: cellKind(cell) === "blank" ? null : cellToNumber(cell), text: cellShownText(cell) };
      });
    }
  }

  // Extract categories and data values from data rows
  const categories: string[] = [];

  for (const row of view.rows) {
    // Skip filter rows and column header rows
    if (row.rowType === "FilterRow" || row.rowType === "ColumnHeader") continue;

    // Skip subtotals unless requested
    if (row.rowType === "Subtotal" && !includeSubtotals) continue;

    // Skip grand totals unless requested
    if (row.rowType === "GrandTotal" && !includeGrandTotal) continue;

    // Skip hidden rows
    if (!row.visible) continue;

    // Build category label from row header cells
    const label = extractRowLabel(row, rowLabelColCount);
    categories.push(label);

    // Extract data values for each series
    for (const [viewCol, seriesData] of seriesMap) {
      const cell = row.cells[viewCol];
      if (cell) {
        const numValue = cellToNumber(cell);
        seriesData.values.push(numValue);
        seriesData.texts.push(cellShownText(cell));
        seriesData.kinds.push(cellKind(cell));
      } else {
        seriesData.values.push(0);
        seriesData.texts.push("");
        seriesData.kinds.push("blank");
      }
    }
  }

  // Build final series array
  const all = Array.from(seriesMap.values());
  const series = all.map((s) => ({
    name: s.name,
    values: s.values,
    color: null as string | null,
  }));

  // What each datum IS: a pivot's EMPTY measure cell (a value with no rows, or
  // the backend's blank total) is "blank", which the visuals write "(Blank)"
  // -- its 0 in `values` is only where a bar chart draws it.
  const datumKinds = all.map((s) => s.kinds);
  const extras = {
    datumKinds,
    ...(seriesTotals ? { seriesTotals } : {}),
  };
  const displayValues = all.map((s) => s.texts);
  // Nothing to say beyond the numbers: leave the field absent (the design-query
  // reader, which calls this, follows the same rule).
  if (displayValues.every((t) => t.every((x) => x === ""))) return { categories, series, ...extras };
  return { categories, series, displayValues, ...extras };
}

/**
 * Display text for a pivot cell. The backend only fills `formattedValue` for
 * custom-formatted numbers (view_to_response trims the rest of the payload) —
 * plain text/number cells carry their content in `value`, exactly like the
 * pivot grid renderer derives its display. Charts must do the same, otherwise
 * every row/column header reads as "" (invisible axis labels, "Value 1"
 * series names).
 */
function cellDisplayText(cell: PivotCellData): string {
  if (cell.formattedValue) return cell.formattedValue;
  const v = cell.value;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return "";
}

/**
 * The text a pivot VALUE cell is shown as, for `displayValues`, or "" for "use
 * the number". A formatted measure's `formattedValue` ("$1,234.50") is the
 * pivot's own answer; a text or boolean value is its text. A PLAIN number with
 * no format is "" — its String() ("0.333333333333") is not how anything showed
 * it, and the visual's display units write it better. The model lane's
 * design-query reader settled the same rule independently (CONTRACT-CANVAS
 * §4.9), so the two sources cannot disagree about one cell.
 */
function cellShownText(cell: PivotCellData): string {
  if (cell.formattedValue) return cell.formattedValue;
  const v = cell.value;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return "";
}

/**
 * Extract column/series names from the column header rows of the pivot view.
 * For single-level column headers, this is straightforward.
 * For multi-level headers, labels are joined with " - ".
 */
function extractColumnNames(view: PivotViewResponse): string[] {
  const { rowLabelColCount, columnHeaderRowCount } = view;

  // Find column header rows
  const headerRows = view.rows.filter((r) => r.rowType === "ColumnHeader");

  // Get data columns
  const dataColumns = view.columns.filter(
    (col) => col.colType === "Data",
  );

  if (dataColumns.length === 0) {
    // Single value field, no column headers: use a generic name
    // Find data-type columns including subtotal/grand total
    const allDataCols = view.columns.filter(
      (col) => col.colType !== "RowLabel",
    );
    if (allDataCols.length === 0) return [];

    return allDataCols.map((col, i) => {
      // Try to get name from the last header row
      if (headerRows.length > 0) {
        const lastHeader = headerRows[headerRows.length - 1];
        const cell = lastHeader.cells[col.viewCol];
        const text = cell ? cellDisplayText(cell) : "";
        if (text) return text;
      }
      return `Value ${i + 1}`;
    });
  }

  // Build names from header rows
  const names: string[] = [];
  for (const col of dataColumns) {
    const parts: string[] = [];
    for (const headerRow of headerRows) {
      const cell = headerRow.cells[col.viewCol];
      if (cell && cell.cellType === "ColumnHeader") {
        const text = cellDisplayText(cell);
        if (text) parts.push(text);
      }
    }
    names.push(parts.length > 0 ? parts.join(" - ") : `Value ${names.length + 1}`);
  }

  return names;
}

/**
 * Extract the category label from a data row's row header cells.
 * For multiple row fields, labels are joined with " > ".
 */
function extractRowLabel(row: PivotRowData, rowLabelColCount: number): string {
  const parts: string[] = [];
  for (let col = 0; col < Math.min(rowLabelColCount, row.cells.length); col++) {
    const cell = row.cells[col];
    if (cell && cell.cellType === "RowHeader") {
      const text = cellDisplayText(cell);
      if (text) parts.push(text);
    }
  }

  if (parts.length === 0) {
    // Subtotal/GrandTotal rows may not have a RowHeader cell type
    // Fall back to any non-empty display text in the row label area
    for (let col = 0; col < Math.min(rowLabelColCount, row.cells.length); col++) {
      const cell = row.cells[col];
      const text = cell ? cellDisplayText(cell) : "";
      if (text) parts.push(text);
    }
  }

  if (parts.length === 0) {
    if (row.rowType === "GrandTotal") return "Grand Total";
    if (row.rowType === "Subtotal") return "Subtotal";
    return "";
  }

  return parts.join(" > ");
}

/** What a pivot value cell IS (ParsedChartData.datumKinds). */
function cellKind(cell: PivotCellData): DatumKind {
  const v = cell.value;
  if (v === null || v === undefined) return "blank";
  if (typeof v === "number") return Number.isFinite(v) ? "number" : "blank";
  return "text";
}

/**
 * Extract a numeric value from a pivot cell.
 * Returns 0 for non-numeric or empty cells.
 */
function cellToNumber(cell: PivotCellData): number {
  if (typeof cell.value === "number") return cell.value;
  if (typeof cell.value === "string") {
    const num = parseFloat(cell.value);
    return isNaN(num) ? 0 : num;
  }
  if (typeof cell.value === "boolean") return cell.value ? 1 : 0;
  return 0;
}

// ============================================================================
// Pivot Field Metadata (for PivotChart filter buttons)
// ============================================================================

/**
 * Fetch pivot field metadata for rendering filter dropdown buttons on a PivotChart.
 * Returns info about row, column, and filter fields currently assigned in the pivot.
 */
export async function fetchPivotChartFields(
  pivotId: string,
): Promise<PivotChartFieldInfo[]> {
  try {
    const hierarchies = await pivot.getHierarchies(pivotId);

    // Collect all field entries with their area
    const entries: Array<{ area: "filter" | "row" | "column"; fieldIndex: number; name: string }> = [];

    for (const f of hierarchies.filterHierarchies) {
      entries.push({ area: "filter", fieldIndex: f.fieldIndex, name: f.name });
    }
    for (const f of hierarchies.rowHierarchies) {
      entries.push({ area: "row", fieldIndex: f.fieldIndex, name: f.name });
    }
    for (const f of hierarchies.columnHierarchies) {
      entries.push({ area: "column", fieldIndex: f.fieldIndex, name: f.name });
    }

    // Check isFiltered for ALL fields in parallel
    const fieldInfoResults = await Promise.allSettled(
      entries.map((e) => pivot.getFieldInfo(pivotId, e.fieldIndex)),
    );

    const fields: PivotChartFieldInfo[] = entries.map((e, i) => {
      const result = fieldInfoResults[i];
      const isFiltered = result.status === "fulfilled" && result.value.isFiltered;
      return {
        area: e.area,
        fieldIndex: e.fieldIndex,
        name: e.name,
        isFiltered,
      };
    });

    return fields;
  } catch {
    return [];
  }
}
