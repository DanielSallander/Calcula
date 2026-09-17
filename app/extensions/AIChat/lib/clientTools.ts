//! FILENAME: app/extensions/AIChat/lib/clientTools.ts
// PURPOSE: The chat tools that run in the WEBVIEW rather than in Rust.
// CONTEXT: Every other tool is dispatched to `ai_chat_run_tool`, because what
//          it does lives in the backend: cells, charts, scripts, queries. An
//          insight overlay lives in TypeScript — a transient store the chart
//          and grid painters read at composite time, never persisted — so the
//          only honest place to run `show_points_of_interest` is here. The
//          tool is declared in `chatTools.ts` like every other (the model
//          sees one flat list), listed in AUTORUN_TOOLS (read-only: it changes
//          nothing in the document), and the surface test knows this set has
//          a client handler INSTEAD of a Rust arm — a name in both places, or
//          in neither, fails that test.
//
//          It reaches the overlay through the `@api/insightsService` seam, so
//          the chat never learns that the Insights extension exists.

import { getInsightsProvider, getSelectedChartId, listChartsForData, type PointsOfInterestTarget } from "@api";

/** Tool names served here. The surface test excludes exactly these from the Rust-arm rule. */
export const CLIENT_TOOL_NAMES: readonly string[] = Object.freeze(["show_points_of_interest"]);

type Handler = (input: Record<string, unknown>) => Promise<string>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Decide what the model pointed at. A chart id wins; a pivot id next; a full
 * rectangle next; with none of them, the selected chart, if there is one.
 */
export function targetFromInput(input: Record<string, unknown>, selectedChartId: string | null): PointsOfInterestTarget | string {
  const chartId = str(input.chart_id);
  if (chartId) return { kind: "chart", chartId };
  const pivotId = str(input.pivot_id);
  if (pivotId) return { kind: "pivot", pivotId };
  const startRow = num(input.start_row);
  const startCol = num(input.start_col);
  const endRow = num(input.end_row);
  const endCol = num(input.end_col);
  if (startRow !== null && startCol !== null && endRow !== null && endCol !== null) {
    const sheetIndex = num(input.sheet_index);
    return { kind: "range", request: { sheetIndex: sheetIndex ?? 0, startRow, startCol, endRow, endCol } };
  }
  if (selectedChartId) return { kind: "chart", chartId: selectedChartId };
  return "Say which chart (chart_id from list_charts), which pivot (pivot_id), or which range (start_row, start_col, end_row, end_col) to show points of interest on. No chart is selected.";
}

const handlers: Record<string, Handler> = {
  async show_points_of_interest(input) {
    const provider = getInsightsProvider();
    if (!provider?.showPointsOfInterest) {
      return "Points of interest are unavailable: the Insights extension is not loaded.";
    }
    const target = targetFromInput(input, getSelectedChartId());
    if (typeof target === "string") return target;
    const r = await provider.showPointsOfInterest(target);
    const where =
      target.kind === "chart"
        ? `chart ${listChartsForData().find((c) => c.chartId === target.chartId)?.name ?? target.chartId}`
        : target.kind === "pivot"
          ? `pivot ${target.pivotId}`
          : `the range on sheet ${target.request.sheetIndex}`;
    if (r.outcome === "refused") return `Could not show points of interest on ${where}: ${r.reason ?? "refused"}.`;
    if (r.count === 0) return `Nothing stands out on ${where}; no points of interest were drawn.`;
    return `Drew ${r.count} point${r.count === 1 ? "" : "s"} of interest on ${where}. ${r.notice ?? ""} The user can step through them on the chart and read each fact's sentence by hovering; do not restate the numbers.`.trim();
  },
};

/** Run a client tool, or null when the name is not one (the caller dispatches to Rust). */
export function runClientTool(name: string, input: unknown): Promise<string> | null {
  const handler = handlers[name];
  if (!handler) return null;
  const args = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return handler(args);
}
