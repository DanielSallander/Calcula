//! FILENAME: app/extensions/Charts/lib/chartModelVisuals.ts
// PURPOSE: The Charts family's provider for @api/modelVisuals (P4, G4, S5):
//          every stored chart, with whether it reads a model and what part it
//          can play in cross-filtering.
// CONTEXT: Edit interactions, a ribbon filter's "Selected visuals" and the
//          script host ask @api/modelVisuals which visuals exist and what each
//          can do; none of them may import Charts (the Seam Rule), so Charts
//          lists its own here.
//
//          - A DESIGN-QUERY chart reads the model (its connection). Its roles
//            come from its mark's declared capability (@api/chartMarks
//            `chartMarkCrossFilter`): a source when the mark is one AND the
//            chart sits on a canvas (cross-filter is canvas only) AND no
//            transform reshapes its data (a transformed chart's datums carry
//            no member path, chartDataReader `withoutSourceText`); always a
//            target; a highlight only when the mark can paint one.
//          - A RANGE chart reads cells: connectionId null, no role, "Reads
//            cells, not the model".
//          - A PIVOTCHART follows its PivotTable (which takes the page's
//            filters itself): connectionId null, no role, its own sentence.
//
//          Pure over the chart store and the page list; `list()` is synchronous.

import { chartMarkCrossFilter, getChartMarkMeta } from "@api/chartMarks";
import { registerModelVisualProvider, type ModelVisualInfo } from "@api/modelVisuals";
import { getReportPagesSnapshot, sheetIdAt, type ReportPagesSnapshot } from "@api/reportPages";
import { getAllCharts } from "./chartStore";
import { isDesignQueryDataSource, isPivotDataSource, type ChartDefinition } from "../types";

/** Why a range chart plays no part (shown on its disabled None icon). */
export const RANGE_CHART_REASON = "Reads cells, not the model";
/** Why a PivotChart plays no part: its PivotTable is the visual that follows the page. */
export const PIVOT_CHART_REASON = "Follows its PivotTable, not the model";
/** Why a design-query chart on a worksheet is not a source. */
export const WORKSHEET_SOURCE_REASON = "Cross-filters from a canvas page only";
/** Why a design-query chart whose mark declares no source capability is not a source. */
export const MARK_NOT_SOURCE_REASON = "This visual does not filter others";
/** Why a transformed design-query chart is not a source. */
export const TRANSFORMED_SOURCE_REASON = "Its data is transformed, so its points name no model member";

/** "Column chart", "Pie chart" -- and the tiles by their own name ("Card", "KPI"). */
function chartLabel(mark: string): string {
  const meta = getChartMarkMeta(mark);
  const base = meta?.label ?? "Chart";
  return meta?.furniture === "titleOnly" ? base : `${base} chart`;
}

/** The cross-filter view of ONE stored chart. Pure. */
export function chartModelVisualInfo(chart: ChartDefinition, pages: ReportPagesSnapshot): ModelVisualInfo {
  const spec = chart.spec;
  const mark = String(spec?.mark ?? "");
  const data = spec?.data;
  const base = {
    ref: { kind: "chart" as const, id: chart.chartId },
    name: chart.name ?? chart.chartId,
    sheetIndex: chart.sheetIndex,
    sheetId: sheetIdAt(pages, chart.sheetIndex),
    label: chartLabel(mark),
  };
  if (isDesignQueryDataSource(data) && data.connectionId) {
    const cap = chartMarkCrossFilter(mark);
    const onCanvas = pages.pages.some((p) => p.index === chart.sheetIndex);
    const transformed = Array.isArray(spec?.transform) && spec.transform.length > 0;
    const reason = !cap.source
      ? MARK_NOT_SOURCE_REASON
      : !onCanvas
        ? WORKSHEET_SOURCE_REASON
        : transformed
          ? TRANSFORMED_SOURCE_REASON
          : null;
    return {
      ...base,
      connectionId: String(data.connectionId),
      role: { source: reason === null, target: true, canHighlight: cap.canHighlight, reason },
    };
  }
  return {
    ...base,
    connectionId: null,
    role: {
      source: false,
      target: false,
      canHighlight: false,
      reason: isPivotDataSource(data) ? PIVOT_CHART_REASON : RANGE_CHART_REASON,
    },
  };
}

/** Every stored chart, as @api/modelVisuals lists it. */
export function listChartModelVisuals(): ModelVisualInfo[] {
  const pages = getReportPagesSnapshot();
  return getAllCharts().map((c) => chartModelVisualInfo(c, pages));
}

/** Register the Charts provider. Returns its unregister function. */
export function registerChartModelVisuals(): () => void {
  return registerModelVisualProvider({ kind: "chart", list: listChartModelVisuals });
}
