//! FILENAME: app/extensions/Reports/lib/dryRunDesignQuery.ts
// PURPOSE: Run a compiled design query without materialising anything, for
//          the "describe the report in words" row above the report dialogs'
//          editor.
// CONTEXT: The shared editor has no backend channel of its own, so the host
//          supplies the dry run over ITS door. `run_design_query` is the
//          headless command the chart data source already uses; it returns
//          the pivot view, of which the row needs only the size.
//          `forReport: true` asks it to answer as the REPORT will (BUG-0450):
//          the query's own FILTERS kept as the report's filter area, and
//          `rowCount` the rows Create Report writes. Without it the dry run
//          took the chart route, where FILTERS run inside the engine, and
//          described a report up to one row per FILTERS field shorter than
//          the one it then wrote.

import type { DesignQueryRequest } from "../../_shared/dsl/pivotLayout/designQuery";
import type { DryRunSummary } from "../../_shared/dsl/pivotLayout/draft";
import { reportsBackend } from "./reportsBackend";

interface ViewSize {
  rowCount: number;
  colCount: number;
}

export async function dryRunDesignQuery(request: DesignQueryRequest): Promise<DryRunSummary> {
  const view = await reportsBackend.invoke<ViewSize>("run_design_query", { request, forReport: true });
  return { rowCount: view?.rowCount ?? 0, colCount: view?.colCount ?? 0 };
}
