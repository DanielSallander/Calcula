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
      if (reports.length === 0) return [];
      // Stable sheet uuids let the channel remap each report to the
      // subscriber's LOCAL sheet index on pull (sheet order may differ).
      const sheetIds = await reportsBackend
        .invoke<string[]>("get_sheet_ids", {})
        .catch(() => [] as string[]);
      return reports.map((r) => ({
        kind: REPORT_KIND,
        id: r.id,
        name: r.name,
        sheetId: sheetIds[r.sheetIndex],
        // The payload keeps its own sheetIndex as a fallback for packages
        // published before sheet-id remapping existed.
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
      const problems: string[] = [];
      for (const obj of objects) {
        const p = obj.payload as Record<string, unknown>;
        const report = {
          id: obj.id,
          name: obj.name,
          dslText: String(p.dslText ?? ""),
          connectionId: String(p.connectionId ?? ""),
          dataSourceId: typeof p.dataSourceId === "string" ? p.dataSourceId : undefined,
          // Prefer the channel-remapped LOCAL index; fall back to the
          // publisher's raw index for payloads without a sheetId.
          sheetIndex: obj.sheetIndex ?? (typeof p.sheetIndex === "number" ? p.sheetIndex : 0),
          anchorRow: Number(p.anchorRow ?? 0),
          anchorCol: Number(p.anchorCol ?? 0),
          endRow: Number(p.endRow ?? 0),
          endCol: Number(p.endCol ?? 0),
        };
        try {
          // restore_report returns a warning string when the report was
          // registered but its BI connection could not be rebound.
          const warning = await reportsBackend.invoke<string | null>("restore_report", {
            report,
          });
          if (warning) problems.push(warning);
        } catch (e) {
          problems.push(`Report "${report.name}" could not be restored: ${String(e)}`);
        }
      }
      if (problems.length > 0) {
        console.warn(`[Reports] .calp pull issues:\n${problems.join("\n")}`);
      }
      emitAppEvent(AppEvents.GRID_REFRESH);
    },
  });
}
