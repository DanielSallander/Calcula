//! FILENAME: app/extensions/Charts/lib/chartCrossFilterPrune.ts
// PURPOSE: A chart that is gone takes its cross-filter selection with it, by
//          WHATEVER route it went -- undo of its creation, a script/MCP/AI
//          removal, the charts a sheet delete takes -- not only by the Delete
//          command (DECISIONS2 P4: "cleared ... on source delete").
// CONTEXT: The Delete command clears its chart's selection when the delete
//          lands (performChartDeleteLanded). Every other removal reaches the
//          frontend as a store reload ("objects"), which swapped the store and
//          left the selection held: the page stayed filtered and every other
//          visual badged "Filtered by" a chart nobody could click to clear.
//          reloadCharts (index.ts) calls this after every swap.

import { pruneMissingCrossFilterSources } from "@api/reportFilters";
import { getAllCharts } from "./chartStore";

/** Clear the cross-filter selection of every chart no longer in the store. */
export function pruneVanishedChartSelections(): void {
  pruneMissingCrossFilterSources(
    "chart",
    getAllCharts().map((c) => c.chartId),
  );
}
