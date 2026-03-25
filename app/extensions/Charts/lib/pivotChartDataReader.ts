//! FILENAME: app/extensions/Charts/lib/pivotChartDataReader.ts
// PURPOSE: Read pivot table aggregated data and convert it to ParsedChartData.
// CONTEXT: PivotCharts use the pivot table's output (PivotViewResponse) as their
//          data source instead of reading from a cell range. This module bridges
//          the pivot view data into the chart rendering pipeline.

import { pivot } from "../../../src/api/pivot";
import type {
  PivotViewResponse,
  PivotRowData,
  PivotCellData,
  PivotColumnData,
} from "../../../src/api/pivot";
import type { ParsedChartData, PivotDataSource, ChartSeries, PivotChartFieldInfo } from "../types";

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
  pivotId: number,
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
function extractChartData(
  view: PivotViewResponse,
  source: PivotDataSource,
): ParsedChartData {
  const { rowLabelColCount, columnHeaderRowCount, filterRowCount } = view;
  const includeSubtotals = source.includeSubtotals ?? false;
  const includeGrandTotal = source.includeGrandTotal ?? false;

  // Identify data columns (columns after the row label columns)
  const dataColumns = view.columns.filter(
    (col) => col.colType === "Data" || col.colType === "Subtotal" || col.colType === "GrandTotal",
  );

  // Extract column/series names from the column header rows
  const columnNames = extractColumnNames(view);

  // Build series arrays (one per data column)
  const seriesMap: Map<number, { name: string; values: number[] }> = new Map();
  for (let i = 0; i < dataColumns.length; i++) {
    seriesMap.set(dataColumns[i].viewCol, {
      name: columnNames[i] ?? `Value ${i + 1}`,
      values: [],
    });
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
      } else {
        seriesData.values.push(0);
      }
    }
  }

  // Build final series array
  const series = Array.from(seriesMap.values()).map((s) => ({
    name: s.name,
    values: s.values,
    color: null as string | null,
  }));

  return { categories, series };
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
        if (cell && cell.formattedValue) return cell.formattedValue;
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
      if (cell && cell.formattedValue && cell.cellType === "ColumnHeader") {
        parts.push(cell.formattedValue);
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
    if (cell && cell.formattedValue && cell.cellType === "RowHeader") {
      parts.push(cell.formattedValue);
    }
  }

  if (parts.length === 0) {
    // Subtotal/GrandTotal rows may not have a RowHeader cell type
    // Fall back to any non-empty formattedValue in the row label area
    for (let col = 0; col < Math.min(rowLabelColCount, row.cells.length); col++) {
      const cell = row.cells[col];
      if (cell && cell.formattedValue) {
        parts.push(cell.formattedValue);
      }
    }
  }

  if (parts.length === 0) {
    if (row.rowType === "GrandTotal") return "Grand Total";
    if (row.rowType === "Subtotal") return "Subtotal";
    return "";
  }

  return parts.join(" > ");
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
  pivotId: number,
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
