//! FILENAME: app/extensions/Reports/lib/dryRunDesignQuery.ts
// PURPOSE: Run a compiled design query without materialising anything, for
//          the "describe the report in words" row above the report dialogs'
//          editor.
// CONTEXT: The shared editor has no backend channel of its own, so the host
//          supplies the dry run over ITS door. `run_design_query` is the
//          headless command the chart data source already uses; it returns
//          the pivot view, of which the row needs only the size.

import type { DesignQueryRequest } from "../../_shared/dsl/pivotLayout/designQuery";
import type { DryRunSummary } from "../../_shared/dsl/pivotLayout/draft";
import { reportsBackend } from "./reportsBackend";

interface ViewSize {
  rowCount: number;
  colCount: number;
}

export async function dryRunDesignQuery(request: DesignQueryRequest): Promise<DryRunSummary> {
  const view = await reportsBackend.invoke<ViewSize>("run_design_query", { request });
  return { rowCount: view?.rowCount ?? 0, colCount: view?.colCount ?? 0 };
}
