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
//   - THE PAGE'S MODEL FILTERS. A model slicer on the chart's sheet or canvas
//     (and, with P4, a ribbon filter scoped to the page or the chart)
//     publishes what it keeps on @api/reportFilters; the compiled request
//     takes what the seam RESOLVES for this chart on its OWN page and
//     connection (`resolveFiltersFor`, the page's interactions applied)
//     before it runs (`mergePageFilters`). The chart re-runs when they change
//     through chartQueryProvider. The page is the chart's sheet, by SHEET ID
//     (@api/reportPages): a caller names the chart
//     (`DesignQueryReadContext.chartId`) or the page itself; a caller that
//     names neither is matched to the stored chart whose spec holds THIS
//     source object (the render path hands the stored spec through by
//     reference), and a source no stored chart holds -- the create dialog's
//     preview -- reads unfiltered, exactly as before. A read that names only
//     a page reads the page's BASE filters (`resolvePageBase`).
//
//   - THE MEASURE-ONLY QUERY. `VALUES: [Sales]` with no ROWS is a Card's
//     query: one number. Its view has no data rows, only the grand total, and
//     the reader used to drop grand totals unconditionally -- so the chart came
//     back with no categories at all. With no row fields the grand total IS the
//     data (`designQueryChartData`).

import type { PivotViewResponse } from "@api/pivot";
import { pivotCellDisplayText } from "@api/pivotMembers";
import { getControlValue } from "@api/controlValues";
import {
  getCrossFilters,
  pruneCrossFilter,
  resolveFiltersFor,
  resolvePageBase,
  type ResolvedFieldFilter,
  type ResolvedTupleFilter,
  type VisualRef,
} from "@api/reportFilters";
import { getReportPagesSnapshot, sheetIdAt } from "@api/reportPages";
import { chartMarkCrossFilter } from "@api/chartMarks";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import {
  compileDesignQuery,
  type DesignQueryFieldRef,
  type DesignQueryRequest,
  type DesignQueryTupleFilter,
} from "../../_shared/dsl/pivotLayout/designQuery";
import { substituteControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import { splitBiFieldKey } from "../../_shared/lib/biFieldKey";
import { chartsBackend } from "./chartsBackend";
import { getAllCharts, getChartById } from "./chartStore";
import { extractChartData } from "./pivotChartDataReader";
import { alignHighlightValues, crossFilterSelfOf, tupleIsLive } from "./chartMemberPaths";
import type { ParsedChartData, DesignQueryDataSource } from "../types";

/**
 * Which chart (or page) a design-query read is for. The page decides which
 * model filters apply (@api/reportFilters): only the chart's own sheet or
 * canvas.
 */
export interface DesignQueryReadContext {
  /** The chart whose source this is; its sheet is the page. */
  chartId?: string;
  /** The page itself. Wins over `chartId`. */
  sheetIndex?: number;
  /**
   * The chart's data formats (`spec.fieldFormats`: bare measure name -> Excel
   * format code). When the key is PRESENT it is used as given (undefined =
   * none) -- the render path hands the spec it is drawing, which may be a
   * preview. When ABSENT they are read from the stored chart the read is for
   * (`chartId`, else the stored chart holding this very source object).
   */
  fieldFormats?: Readonly<Record<string, string>>;
}

/**
 * The data formats a read applies: the context's own when it names them,
 * else the stored chart's (by id, else by IDENTITY of the source, as
 * {@link designQueryPageOf} finds the page). A preview of a chart not created
 * yet has none.
 */
export function designQueryFieldFormatsOf(
  source: DesignQueryDataSource,
  context?: DesignQueryReadContext,
): Readonly<Record<string, string>> | undefined {
  if (context && Object.prototype.hasOwnProperty.call(context, "fieldFormats")) return context.fieldFormats;
  if (context?.chartId !== undefined) return getChartById(context.chartId)?.spec?.fieldFormats;
  return getAllCharts().find((c) => c.spec?.data === source)?.spec?.fieldFormats;
}

/**
 * The request with each value field's chosen number format, pure. A format is
 * matched by the BARE measure name (`fieldFormats` keys and the compiled
 * `measureName` are both bracket-free); a measure with no entry, or an empty
 * one, carries no `numberFormat` key at all, so the backend's default stands.
 * Rust formats `formattedValue` with it (invariant locale) and adopts NOTHING
 * from the model on this headless path.
 */
export function applyFieldFormats(
  request: DesignQueryRequest,
  fieldFormats: Readonly<Record<string, string>> | undefined,
): DesignQueryRequest {
  if (!fieldFormats) return request;
  let changed = false;
  const valueFields = request.valueFields.map((f) => {
    const format = Object.prototype.hasOwnProperty.call(fieldFormats, f.measureName)
      ? fieldFormats[f.measureName]
      : undefined;
    if (typeof format !== "string" || format === "") return f;
    changed = true;
    return { ...f, numberFormat: format };
  });
  return changed ? { ...request, valueFields } : request;
}

/**
 * The stored chart a read is for: the context's chart, else the stored chart
 * whose spec holds THIS source object (by IDENTITY, never by content: two
 * charts on different pages may hold the same DSL text against the same
 * connection, and only the object tells them apart). Undefined for a preview.
 */
function designQueryChartOf(source: DesignQueryDataSource, context?: DesignQueryReadContext) {
  if (context?.chartId !== undefined) return getChartById(context.chartId);
  return getAllCharts().find((c) => c.spec?.data === source);
}

/**
 * The page a read is for, as its SHEET ID (@api/reportPages), or undefined
 * when it is for no stored chart (a preview of a chart not created yet) or the
 * page list has no id for the sheet yet. The sheet index is the context's
 * page, else the chart's sheet. See the file header for the order.
 */
export function designQueryPageOf(
  source: DesignQueryDataSource,
  context?: DesignQueryReadContext,
): string | undefined {
  const index =
    context?.sheetIndex !== undefined ? context.sheetIndex : designQueryChartOf(source, context)?.sheetIndex;
  if (index === undefined) return undefined;
  return sheetIdAt(getReportPagesSnapshot(), index) ?? undefined;
}

/**
 * A "Table.Column" field split against the model, or empty parts when it
 * names no table OF THE MODEL. `splitBiFieldKey` falls back to the first dot
 * when no model table prefixes the key, so "Gone.Thing" would come back as
 * table "Gone" -- a table the backend refuses, failing the whole query
 * instead of skipping only that filter.
 */
function splitModelField(field: string, tableNames: readonly string[]): { table: string; column: string } {
  const split = splitBiFieldKey(field, [...tableNames]);
  return tableNames.includes(split.table) ? split : { table: "", column: "" };
}

/**
 * The request with the resolved model filters merged in, pure. Each filter
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
  filters: readonly ResolvedFieldFilter[],
  tableNames: readonly string[],
): DesignQueryRequest {
  if (filters.length === 0) return request;
  const pageFilterFields: DesignQueryFieldRef[] = [...(request.pageFilterFields ?? [])];
  for (const filter of filters) {
    const { table, column } = splitModelField(filter.field, tableNames);
    if (!table || !column) {
      console.warn(
        `[Charts] "${filter.from}" filters "${filter.field}", which this model has no table for; not applied.`,
      );
      continue;
    }
    const level = typeof filter.level === "number" && filter.level > 1 ? { level: filter.level } : {};
    pageFilterFields.push({ table, column, includedItems: [...filter.includedKeys], ...level });
  }
  return { ...request, pageFilterFields };
}

/**
 * The request with the resolved TUPLE filters (OR-of-AND: a non-rectangular
 * cross-filter selection, P4) appended to `tupleFilters`, pure. Each field is
 * split against the model the way `mergePageFilters` splits one; a tuple
 * filter naming a column the model does not have is skipped whole (and said
 * in the console) -- dropping only that column would WIDEN it to every member
 * of the column, a filter the user never made. Keys travel as they are (the
 * blank member is key "", ruling Q8; the backend maps it to the engine's
 * blank). Always level 1: a selection is never pinned.
 */
export function mergeTupleFilters(
  request: DesignQueryRequest,
  tupleFilters: readonly ResolvedTupleFilter[],
  tableNames: readonly string[],
): DesignQueryRequest {
  if (tupleFilters.length === 0) return request;
  const out: DesignQueryTupleFilter[] = [...(request.tupleFilters ?? [])];
  for (const tf of tupleFilters) {
    const fields: Array<{ table: string; column: string }> = [];
    let missing: string | null = null;
    for (const field of tf.fields) {
      const { table, column } = splitModelField(field, tableNames);
      if (!table || !column) {
        missing = field;
        break;
      }
      fields.push({ table, column });
    }
    if (missing !== null) {
      console.warn(`[Charts] "${tf.from}" filters "${missing}", which this model has no table for; not applied.`);
      continue;
    }
    out.push({ fields, tuples: tf.tuples.map((t) => [...t]) });
  }
  if (out.length === (request.tupleFilters ?? []).length) return request;
  return { ...request, tupleFilters: out };
}

/**
 * What a design-query read runs (see {@link compileDesignQueryPlan}).
 */
export interface DesignQueryPlan {
  /** The query the chart draws: its DSL plus the filters that reach it. */
  request: DesignQueryRequest;
  /**
   * The CROSS-HIGHLIGHT query, or null when no selection highlights the chart:
   * `request` plus the highlight-mode selections' filters. Its result is
   * aligned onto the base by member key (`highlightValues`).
   */
  highlightRequest: DesignQueryRequest | null;
  /** The chart the read is for and its page (sheet id), when it is a stored chart on a known page. */
  self: { ref: VisualRef; pageSheetId: string; connectionId: string } | null;
}

/**
 * The compiled request behind a design-query source — the DSL against the
 * connection's model, with @Name params substituted from the live controls,
 * each measure's chosen number format attached (`applyFieldFormats`), and
 * the model filters of the chart's own page merged in.
 *
 * Shared by the reader (which runs it) and the data provider (which reads its
 * `valueFields` to say which measure each plotted series is), so the two can
 * never disagree about what the chart asked for.
 */
export async function compileDesignQuerySource(
  source: DesignQueryDataSource,
  context?: DesignQueryReadContext,
): Promise<DesignQueryRequest> {
  return (await compileDesignQueryPlan(source, context)).request;
}

/**
 * {@link compileDesignQuerySource} plus what only the READ needs: the
 * cross-highlight query and the chart's own identity (P4, S5).
 *
 * The chart asks the seam ONE question -- `resolveFiltersFor(page, chart,
 * connection)` with its mark's `canHighlight` (@api/chartMarks) -- and routes
 * the answer:
 *   - `filters` (page / ribbon filters and rectangular filter-mode selections)
 *     go to `pageFilterFields`, keyed by member KEY;
 *   - `tupleFilters` (non-rectangular filter-mode selections) go to
 *     `tupleFilters`;
 *   - `highlights`, when any, make a SECOND request: the base plus the
 *     highlight filters. A mark that cannot highlight never gets one (the
 *     resolver forced its selections to filter).
 * The chart's OWN selection never filters it (the resolver drops it).
 */
export async function compileDesignQueryPlan(
  source: DesignQueryDataSource,
  context?: DesignQueryReadContext,
): Promise<DesignQueryPlan> {
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

  // The chart's data formats (the Format tab's Data format card) ride the
  // value fields, so the backend writes `formattedValue` in them.
  const formatted = applyFieldFormats(compiled.request, designQueryFieldFormatsOf(source, context));

  // The page's model filters (@api/reportFilters): only this chart's own
  // sheet or canvas, only this connection's model, under the page's
  // interactions for THIS chart. A read that names a page and no chart reads
  // the page's base.
  const page = designQueryPageOf(source, context);
  if (page === undefined) return { request: formatted, highlightRequest: null, self: null };
  const connectionId = String(source.connectionId);
  const chart =
    context?.sheetIndex !== undefined && context.chartId === undefined ? undefined : designQueryChartOf(source, context);
  const ref: VisualRef | null = chart ? { kind: "chart", id: chart.chartId } : null;
  const resolved = ref
    ? resolveFiltersFor(
        page,
        { ref, canHighlight: chartMarkCrossFilter(chart?.spec?.mark ?? "").canHighlight },
        connectionId,
      )
    : resolvePageBase(page, connectionId);
  const tables = biModel.tables.map((t) => t.name);
  const request = mergeTupleFilters(mergePageFilters(formatted, resolved.filters, tables), resolved.tupleFilters, tables);
  const highlightRequest = resolved.highlights
    ? mergeTupleFilters(
        mergePageFilters(request, resolved.highlights.filters, tables),
        resolved.highlights.tupleFilters,
        tables,
      )
    : null;
  return {
    request,
    highlightRequest,
    self: ref ? { ref, pageSheetId: page, connectionId } : null,
  };
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
  // A header names a member: show its app-locale LABEL (the one reading,
  // `pivotCellDisplayText`); a value cell carries no member and falls through.
  if (cell.member) return pivotCellDisplayText(cell);
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
 * The chart's OWN cross-filter selection laid onto its data (P4): first its
 * vanished tuples are pruned (a member the query no longer returns cannot stay
 * selected -- `pruneCrossFilter`), then the datums still selected are marked
 * (`crossFilterSelf`) so the painter can fade the rest. Data without member
 * paths leaves the selection alone: it cannot tell which members vanished.
 */
function withOwnSelection(data: ParsedChartData, self: NonNullable<DesignQueryPlan["self"]>): ParsedChartData {
  if (!data.categoryMembers || !data.seriesMembers) return data;
  const own = () =>
    getCrossFilters(self.pageSheetId).find(
      (s) => s.source.kind === self.ref.kind && s.source.id === self.ref.id && s.connectionId === self.connectionId,
    );
  if (!own()) return data;
  pruneCrossFilter(self.ref, (fields, tuple) => tupleIsLive(data, fields, tuple));
  const held = own();
  if (!held) return data;
  const crossFilterSelf = crossFilterSelfOf(data, held);
  return crossFilterSelf ? { ...data, crossFilterSelf } : data;
}

/** Charts already told their highlight could not be aligned (one console line each). */
const unalignedHighlightNoted = new Set<string>();

/**
 * Read data for a design-query chart and return it as ParsedChartData.
 *
 * Flow: fetch the connection's BI model → compile the DSL into a
 * `DesignQueryRequest` (page filters merged) → run it headlessly on the
 * backend → extract categories and series from the returned pivot view.
 *
 * Cross-filter (P4): the chart's own selection is pruned and marked
 * (`crossFilterSelf`); when another visual's selection HIGHLIGHTS the chart, a
 * second query runs with the highlight filters and its values are aligned
 * onto the base datums BY MEMBER KEY (`highlightValues`). A highlight that
 * cannot be aligned (no member paths) or whose query fails is left off -- the
 * chart paints unhighlighted and says so in the console, never a value at the
 * wrong datum.
 */
export async function readDesignQueryData(
  source: DesignQueryDataSource,
  context?: DesignQueryReadContext,
): Promise<ParsedChartData> {
  const plan = await compileDesignQueryPlan(source, context);

  const view = await chartsBackend.invoke<PivotViewResponse>("run_design_query", {
    request: plan.request satisfies DesignQueryRequest,
  });
  if (!view) {
    return { categories: [], series: [] };
  }

  let data = designQueryChartData(view, plan.request);
  if (plan.self) data = withOwnSelection(data, plan.self);

  if (plan.highlightRequest) {
    const noteKey = plan.self ? plan.self.ref.id : source.dslText;
    try {
      const highlightView = await chartsBackend.invoke<PivotViewResponse>("run_design_query", {
        request: plan.highlightRequest satisfies DesignQueryRequest,
      });
      const highlighted = highlightView ? designQueryChartData(highlightView, plan.highlightRequest) : null;
      const aligned = highlighted ? alignHighlightValues(data, highlighted) : null;
      if (aligned) {
        data = { ...data, highlightValues: aligned };
        unalignedHighlightNoted.delete(noteKey);
      } else if (!unalignedHighlightNoted.has(noteKey)) {
        unalignedHighlightNoted.add(noteKey);
        console.warn("[Charts] A cross-highlight could not be matched to this chart's datums by member; painted without it.");
      }
    } catch (err) {
      console.warn("[Charts] The cross-highlight query failed; the chart is painted without the highlight:", err);
    }
  }

  return data;
}
