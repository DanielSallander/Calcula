//! FILENAME: app/extensions/Charts/lib/designQueryChartDataReader.ts
// PURPOSE: Read a chart's "design query" data source and convert it to
//   ParsedChartData. Unlike a PivotChart (which reads a pivot table's view), a
//   design-query chart holds the pivot-layout DSL itself and runs it headlessly
//   against a BI model connection — the data lives in the chart object.
// CONTEXT: Sibling of pivotChartDataReader. It compiles the DSL (shared DSL in
//   _shared/dsl/pivotLayout) into a backend request, runs `run_design_query`
//   (which returns a standard PivotViewResponse), and reuses the pivot→chart
//   extraction verbatim.
//
//   Two things a Power BI page needs live here (CONTRACT-CANVAS §4.8, owner
//   decision 5 of 2026-10-08):
//
//   - THE PAGE'S MODEL SLICERS. A model slicer on the chart's sheet or canvas
//     publishes what it keeps on @api/pageFilters; the compiled request takes
//     those filters for the chart's OWN page and connection before it runs
//     (`mergePageFilters`). The chart re-runs when they change through
//     chartQueryProvider. The page is the chart's sheet: a caller names the
//     chart (`DesignQueryReadContext.chartId`) or the page itself; a caller
//     that names neither is matched to the stored chart whose spec holds THIS
//     source object (the render path hands the stored spec through by
//     reference), and a source no stored chart holds -- the create dialog's
//     preview -- reads unfiltered, exactly as before.
//
//   - THE MEASURE-ONLY QUERY. `VALUES: [Sales]` with no ROWS is a Card's
//     query: one number. Its view has no data rows, only the grand total, and
//     the reader used to drop grand totals unconditionally -- so the chart came
//     back with no categories at all. With no row fields the grand total IS the
//     data (`designQueryChartData`).

import type { PivotViewResponse } from "@api/pivot";
import { getControlValue } from "@api/controlValues";
import { getPageFilters, type PageFilter } from "@api/pageFilters";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import {
  compileDesignQuery,
  type DesignQueryFieldRef,
  type DesignQueryRequest,
} from "../../_shared/dsl/pivotLayout/designQuery";
import { substituteControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";
import { chartsBackend } from "./chartsBackend";
import { getAllCharts, getChartById } from "./chartStore";
import { extractChartData } from "./pivotChartDataReader";
import type { ParsedChartData, DesignQueryDataSource } from "../types";

/**
 * Which chart (or page) a design-query read is for. The page decides which
 * model-slicer filters apply (@api/pageFilters): only the chart's own sheet or
 * canvas.
 */
export interface DesignQueryReadContext {
  /** The chart whose source this is; its sheet is the page. */
  chartId?: string;
  /** The page itself. Wins over `chartId`. */
  sheetIndex?: number;
}

/**
 * The page a read is for, or undefined when it is for no stored chart (a
 * preview of a chart not created yet). See the file header for the order.
 */
export function designQueryPageOf(
  source: DesignQueryDataSource,
  context?: DesignQueryReadContext,
): number | undefined {
  if (context?.sheetIndex !== undefined) return context.sheetIndex;
  if (context?.chartId !== undefined) return getChartById(context.chartId)?.sheetIndex;
  // By IDENTITY, never by content: two charts on different pages may hold the
  // same DSL text against the same connection, and only the object tells
  // them apart.
  return getAllCharts().find((c) => c.spec?.data === source)?.sheetIndex;
}

/**
 * The request with the page's model filters merged in, pure. Each filter
 * KEEPS its items of one model column and travels in `pageFilterFields`,
 * APART from the query's own zones:
 *
 * - the backend runs every page filter INSIDE the engine query (headless.rs
 *   `page_filter_fields`), never as a GROUP BY column. Appending them to the
 *   query's FILTERS used to group the chart by the slicer column and roll the
 *   groups back up with SUM -- exact only when one group fed each bar: under a
 *   slicer keeping East and West an AVERAGE bar read avg(East) + avg(West), a
 *   distinct count double-counted, and a slicer on a 50,000-member column made
 *   every chart on the page fetch Region x Customer rows on every click;
 * - a column the query already places (ROWS, COLUMNS, FILTERS) is filtered by
 *   the engine just the same, so its ref is left exactly as compiled;
 * - two filters on one column (two slicers on Region) are two entries, which
 *   the engine applies together, the way two Power BI slicers on one field do;
 * - a PINNED slicer (`filterLevel` 2..9) carries its `level`, so a measure
 *   that CLEARs the column keeps the pin exactly as it does in a BI pivot on
 *   the same page.
 *
 * A filter whose field names no table of the model is skipped (and said in
 * the console): a column the model does not have cannot be kept, and sending
 * it would fail the whole query instead of only that filter.
 */
export function mergePageFilters(
  request: DesignQueryRequest,
  filters: readonly PageFilter[],
  tableNames: readonly string[],
): DesignQueryRequest {
  if (filters.length === 0) return request;
  const pageFilterFields: DesignQueryFieldRef[] = [...(request.pageFilterFields ?? [])];
  for (const filter of filters) {
    const { table, column } = splitBiFieldKey(filter.field, [...tableNames]);
    if (!table || !column) {
      console.warn(
        `[Charts] "${filter.sourceName}" filters "${filter.field}", which this model has no table for; not applied.`,
      );
      continue;
    }
    const level = typeof filter.filterLevel === "number" && filter.filterLevel > 1 ? { level: filter.filterLevel } : {};
    pageFilterFields.push({ table, column, includedItems: [...filter.includedItems], ...level });
  }
  return { ...request, pageFilterFields };
}

/**
 * The compiled request behind a design-query source — the DSL against the
 * connection's model, with @Name params substituted from the live controls,
 * and the model filters of the chart's own page merged in.
 *
 * Shared by the reader (which runs it) and the data provider (which reads its
 * `valueFields` to say which measure each plotted series is), so the two can
 * never disagree about what the chart asked for.
 */
export async function compileDesignQuerySource(
  source: DesignQueryDataSource,
  context?: DesignQueryReadContext,
): Promise<DesignQueryRequest> {
  if (!source.connectionId) {
    throw new Error("This design-query chart has no BI connection selected.");
  }

  const biModel = await chartsBackend.invoke<BiPivotModelInfo | null>(
    "get_connection_bi_model",
    { connectionId: source.connectionId },
  );
  if (!biModel) {
    throw new Error(
      "The BI model for this design query is not loaded. Open its connection first.",
    );
  }

  // Resolve @Name params against current control / ribbon-filter values — the
  // same binding standard reports use (a chart's FILTERS can be driven by a
  // pane control or ribbon filter; the shared query-object refresh service
  // re-runs the chart when a bound value changes).
  const substituted = substituteControlParams(source.dslText, getControlValue);
  const compiled = compileDesignQuery(substituted, source.connectionId, biModel);
  if (!compiled.request) {
    const detail = compiled.errors
      .map((e) => `Line ${e.location.line}: ${e.message}`)
      .join("\n");
    throw new Error(`Design query has errors (after @param substitution):\n${detail}`);
  }

  // The page's model slicers (@api/pageFilters): only this chart's own sheet
  // or canvas, only this connection's model.
  const page = designQueryPageOf(source, context);
  if (page === undefined) return compiled.request;
  const filters = getPageFilters(page, String(source.connectionId));
  return mergePageFilters(
    compiled.request,
    filters,
    biModel.tables.map((t) => t.name),
  );
}

/**
 * The chart data of a design query's view, pure.
 *
 * With ROW fields the categories are the data rows -- subtotals and the grand
 * total are excluded (they would be spurious extra categories).
 *
 * With NO row fields (a measure-only query: a Card, a Gauge, a KPI's single
 * value; or COLUMNS only) the grand total IS the data: it is the one category.
 * Only the grand-total row is read even when the backend also emits a data
 * row (the BI values-only shape carries a synthetic "Total" row field), so the
 * chart never shows the same number twice. When the layout hides the grand
 * total the data rows are all there is, and they are read instead.
 */
export function designQueryChartData(
  view: PivotViewResponse,
  request: Pick<DesignQueryRequest, "rowFields"> & Partial<Pick<DesignQueryRequest, "valueFields">>,
): ParsedChartData {
  return withMeasureCaptions(designQueryViewData(view, request), request.valueFields ?? []);
}

/**
 * A measure's caption the way Power BI writes it: "Revenue", not "[Revenue]".
 *
 * The DSL compiler names every un-aliased measure "[Revenue]" (the PivotEditor
 * convention the pivot grid shows), so a design-query Card captioned its
 * number "[Revenue]". One enclosing pair of brackets is dropped from a series
 * name -- or from its last " - " part under column fields -- when that part is
 * exactly a requested measure's bracketed name and the query gave it no alias
 * of its own. An alias is the author's caption and is left as written.
 */
function withMeasureCaptions(
  data: ParsedChartData,
  valueFields: ReadonlyArray<{ measureName: string; customName?: string }>,
): ParsedChartData {
  const bracketed = new Map<string, string>();
  for (const f of valueFields) {
    const b = `[${f.measureName}]`;
    if (f.customName === undefined || f.customName === "" || f.customName === b) bracketed.set(b, f.measureName);
  }
  if (bracketed.size === 0) return data;
  let changed = false;
  const series = data.series.map((s) => {
    const parts = s.name.split(" - ");
    const last = parts[parts.length - 1];
    const plain = bracketed.get(last);
    if (plain === undefined) return s;
    changed = true;
    parts[parts.length - 1] = plain;
    return { ...s, name: parts.join(" - ") };
  });
  return changed ? { ...data, series } : data;
}

function designQueryViewData(
  view: PivotViewResponse,
  request: Pick<DesignQueryRequest, "rowFields">,
): ParsedChartData {
  if (request.rowFields.length === 0) {
    const hasGrandTotal = view.rows.some((r) => r.rowType === "GrandTotal" && r.visible);
    if (hasGrandTotal) {
      const totalOnly: PivotViewResponse = {
        ...view,
        rows: view.rows.filter((r) => r.rowType !== "Data" && r.rowType !== "Subtotal"),
      };
      return withDisplayValues(
        extractChartData(totalOnly, { includeSubtotals: false, includeGrandTotal: true }),
        totalOnly,
        true,
      );
    }
  }
  return withDisplayValues(
    extractChartData(view, { includeSubtotals: false, includeGrandTotal: false }),
    view,
    false,
  );
}

/**
 * The text a model value is SHOWN as, or "" for "use the number". A measure
 * with a format string arrives with `formattedValue` ("$1,234.50", "12.5%"),
 * and a Card must keep it (CONTRACT-CANVAS §4.9): that text is the model's
 * own answer to "how is this written". A text value is its text. A plain
 * number with no format is "" -- the visual's display units write it; the
 * raw float's String() ("0.333333333333") is not how anything showed it.
 */
function modelCellText(cell: PivotViewResponse["rows"][number]["cells"][number] | undefined): string {
  if (!cell) return "";
  if (cell.formattedValue) return cell.formattedValue;
  const v = cell.value;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return "";
}

/**
 * `data` with `displayValues[series][category]` read from the same view
 * cells `extractChartData` read its numbers from: the same rows (no filter or
 * header rows, no subtotals, the grand total only when included, visible
 * only) and the same value columns (Data, Subtotal, GrandTotal, in order).
 *
 * If the pivot reader one day fills `displayValues` itself, its answer is
 * kept. If the two walks ever disagree on the SHAPE (a category or series
 * count that does not match), no display values are attached: absent means
 * "use the number", which is always true, while a misaligned text beside a
 * number is the one wrong answer the field must never give.
 */
function withDisplayValues(
  data: ParsedChartData,
  view: PivotViewResponse,
  includeGrandTotal: boolean,
): ParsedChartData {
  if (data.displayValues) return data;
  const valueColumns = view.columns.filter(
    (c) => c.colType === "Data" || c.colType === "Subtotal" || c.colType === "GrandTotal",
  );
  const rows = view.rows.filter(
    (r) =>
      r.rowType !== "FilterRow" &&
      r.rowType !== "ColumnHeader" &&
      r.rowType !== "Subtotal" &&
      (r.rowType !== "GrandTotal" || includeGrandTotal) &&
      r.visible,
  );
  if (rows.length !== data.categories.length || valueColumns.length !== data.series.length) {
    return data;
  }
  const displayValues = valueColumns.map((c) => rows.map((r) => modelCellText(r.cells[c.viewCol])));
  // Nothing to say beyond the numbers: leave the field absent.
  if (displayValues.every((s) => s.every((t) => t === ""))) return data;
  return { ...data, displayValues };
}

/**
 * Read data for a design-query chart and return it as ParsedChartData.
 *
 * Flow: fetch the connection's BI model → compile the DSL into a
 * `DesignQueryRequest` (page filters merged) → run it headlessly on the
 * backend → extract categories and series from the returned pivot view.
 */
export async function readDesignQueryData(
  source: DesignQueryDataSource,
  context?: DesignQueryReadContext,
): Promise<ParsedChartData> {
  const request = await compileDesignQuerySource(source, context);

  const view = await chartsBackend.invoke<PivotViewResponse>("run_design_query", {
    request: request satisfies DesignQueryRequest,
  });
  if (!view) {
    return { categories: [], series: [] };
  }

  return designQueryChartData(view, request);
}
