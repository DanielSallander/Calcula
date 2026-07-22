//! FILENAME: app/extensions/Charts/lib/chartQueryProvider.ts
// PURPOSE: Register design-query charts with the shared query-object refresh
//   service — a chart whose DSL binds a control / ribbon filter via @Name is
//   invalidated + repainted when that bound value changes (the same targeted,
//   coalesced pass that re-materializes grid reports).

import { emitAppEvent, AppEvents } from "@api/events";
import {
  registerQueryObjectProvider,
  type QueryObjectBinding,
} from "../../_shared/lib/queryObjectRefresh";
import { extractControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import { getAllCharts } from "./chartStore";
import { isDesignQueryDataSource } from "../types";
import { invalidateChartCache } from "../rendering/chartRenderer";

/** Register the "chart" family. Returns an unregister fn. */
export function registerChartQueryProvider(): () => void {
  return registerQueryObjectProvider({
    kind: "chart",
    listBindings: async () => {
      const bindings: QueryObjectBinding[] = [];
      for (const chart of getAllCharts()) {
        const data = chart.spec?.data;
        if (!isDesignQueryDataSource(data)) continue;
        bindings.push({
          id: chart.chartId,
          name: chart.name ?? chart.chartId,
          boundControls: extractControlParams(data.dslText),
        });
      }
      return bindings;
    },
    refreshObjects: async (ids) => {
      for (const id of ids) {
        invalidateChartCache(id);
      }
      // Charts are canvas OVERLAYS: the repaint-only app event is the correct
      // one here (the invalidated charts refetch their data on redraw) — no
      // grid-cell refetch is involved.
      emitAppEvent(AppEvents.GRID_REFRESH);
    },
  });
}
