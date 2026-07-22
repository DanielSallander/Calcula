//! FILENAME: app/extensions/Reports/lib/reportQueryProvider.ts
// PURPOSE: Register grid reports with the shared query-object refresh service —
//   reports bound (via @Name in FILTERS) to a changed control / ribbon filter
//   are re-materialized by the service's targeted, coalesced pass.

import { registerQueryObjectProvider } from "../../_shared/lib/queryObjectRefresh";
import { extractControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import { listReports, refreshReport, refreshGridCells } from "./reportRefresh";
import type { ReportInfo } from "../types";

/** Register the "report" family. Returns an unregister fn. */
export function registerReportQueryProvider(): () => void {
  // listBindings() runs immediately before refreshObjects() in the same pass;
  // keep the listed reports so refresh doesn't re-fetch them per object.
  let lastListed = new Map<string, ReportInfo>();

  return registerQueryObjectProvider({
    kind: "report",
    listBindings: async () => {
      const reports = await listReports();
      lastListed = new Map(reports.map((r) => [r.id, r]));
      return reports.map((r) => ({
        id: r.id,
        name: r.name,
        boundControls: extractControlParams(r.dslText),
      }));
    },
    refreshObjects: async (ids) => {
      let any = false;
      for (const id of ids) {
        const report = lastListed.get(id);
        if (!report) continue;
        const result = await refreshReport(report, { auto: true });
        if (result.ok) {
          any = true;
        } else {
          console.warn(`[Reports] Auto-refresh of "${report.name}" failed: ${result.message}`);
        }
      }
      if (any) refreshGridCells();
    },
  });
}
