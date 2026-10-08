//! FILENAME: app/extensions/Charts/rendering/visuals/index.ts
// PURPOSE: Folder-as-module entry for the tile visuals — Power BI's Card,
//          Multi-row card, KPI and Gauge, built as built-in chart marks
//          (owner decision 2026-10-08; survey canvas-survey/objects.md §4-5).
// CONTEXT: chartDispatch registers each one exactly like the other built-ins.
//          Every visual registers `layoutFamily: "other"` (no axes) and
//          `furniture: "titleOnly"` (a title and nothing else), and shares
//          visualValues.ts (what number, written how) and visualLayout.ts.

export { paintCardChart, computeCardLayout, computeCardBarRects } from "./cardPainter";
export {
  paintMultiRowCardChart,
  computeMultiRowCardLayout,
  computeMultiRowCardBarRects,
} from "./multiRowCardPainter";
export { paintKpiChart, computeKpiLayout, computeKpiPointMarkers, kpiStatus, KPI_DEFAULT_COLORS } from "./kpiPainter";
export { paintGaugeChart, computeGaugeLayout, computeGaugeBarRects, resolveGaugeScale, GAUGE_TRACK_COLOR } from "./gaugePainter";
export {
  aggregateSeries,
  formatVisualNumber,
  formatVisualValue,
  isTextDatum,
  datumText,
  BLANK_TEXT,
  type VisualValue,
} from "./visualValues";
