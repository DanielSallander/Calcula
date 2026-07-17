//! FILENAME: app/extensions/Charts/lib/chartEvents.ts
// PURPOSE: Chart-specific event name constants.
// CONTEXT: Used with emitAppEvent / onAppEvent for chart lifecycle events.

export const ChartEvents = {
  /** Emitted after a new chart is created. Detail: { chartId: string } */
  CHART_CREATED: "chart:created",
  /** Emitted after a chart spec or placement is updated. Detail: { chartId: string } */
  CHART_UPDATED: "chart:updated",
  /** Emitted after a chart is deleted. Detail: { chartId: string } */
  CHART_DELETED: "chart:deleted",
  /** Request to delete a chart (from UI like the context menu); handled in
   *  index.ts so deletion runs the same sequence as the Delete key.
   *  Detail: { chartId: string } */
  CHART_DELETE_REQUEST: "chart:delete-request",
} as const;
