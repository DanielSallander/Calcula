//! FILENAME: app/extensions/Charts/lib/chartEvents.ts
// PURPOSE: Chart-specific event name constants.
// CONTEXT: Used with emitAppEvent / onAppEvent for chart lifecycle events.

export const ChartEvents = {
  /** Emitted after a new chart is created. Detail: { chartId: number } */
  CHART_CREATED: "chart:created",
  /** Emitted after a chart spec or placement is updated. Detail: { chartId: number } */
  CHART_UPDATED: "chart:updated",
  /** Emitted after a chart is deleted. Detail: { chartId: number } */
  CHART_DELETED: "chart:deleted",
} as const;
