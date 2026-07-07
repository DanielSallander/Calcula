//! FILENAME: app/extensions/Reports/lib/reportDistribution.ts
// PURPOSE: Publish / subscribe grid reports in `.calp` packages via the generic
//   distributable-object channel (@api/distributableObjects). The report's CELLS
//   travel with the package's sheet grid, so a subscriber sees the data offline;
//   this ships the report DEFINITION (rebound to the subscriber's BI connection
//   by its stable data-source id) so it can be refreshed / deleted / managed.

import { registerDistributableObjectProvider } from "@api/distributableObjects";
import { emitAppEvent, AppEvents } from "@api/events";
import { reportsBackend } from "./reportsBackend";
import { listReports } from "./reportRefresh";

const REPORT_KIND = "calcula.report";

/** Register the report distributable-object provider. Returns an unregister fn. */
export function registerReportDistribution(): () => void {
  return registerDistributableObjectProvider({
    kind: REPORT_KIND,
    collect: async () => {
      const reports = await listReports();
      return reports.map((r) => ({
        kind: REPORT_KIND,
        id: r.id,
        name: r.name,
        // The definition carries its own sheetIndex; report cells travel with the
        // sheet grid. (v1 assumes a matching sheet layout across publish/pull.)
        payload: {
          dslText: r.dslText,
          connectionId: r.connectionId,
          dataSourceId: r.dataSourceId,
          sheetIndex: r.sheetIndex,
          anchorRow: r.anchorRow,
          anchorCol: r.anchorCol,
          endRow: r.endRow,
          endCol: r.endCol,
        },
      }));
    },
    materialize: async (objects) => {
      for (const obj of objects) {
        const p = obj.payload as Record<string, unknown>;
        const report = {
          id: obj.id,
          name: obj.name,
          dslText: String(p.dslText ?? ""),
          connectionId: String(p.connectionId ?? ""),
          dataSourceId: typeof p.dataSourceId === "string" ? p.dataSourceId : undefined,
          sheetIndex: obj.sheetIndex ?? (typeof p.sheetIndex === "number" ? p.sheetIndex : 0),
          anchorRow: Number(p.anchorRow ?? 0),
          anchorCol: Number(p.anchorCol ?? 0),
          endRow: Number(p.endRow ?? 0),
          endCol: Number(p.endCol ?? 0),
        };
        await reportsBackend.invoke("restore_report", { report }).catch(() => {});
      }
      emitAppEvent(AppEvents.GRID_REFRESH);
    },
  });
}
