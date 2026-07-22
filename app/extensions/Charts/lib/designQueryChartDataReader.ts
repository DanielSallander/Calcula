//! FILENAME: app/extensions/Charts/lib/designQueryChartDataReader.ts
// PURPOSE: Read a chart's "design query" data source and convert it to
//   ParsedChartData. Unlike a PivotChart (which reads a pivot table's view), a
//   design-query chart holds the pivot-layout DSL itself and runs it headlessly
//   against a BI model connection — the data lives in the chart object.
// CONTEXT: Sibling of pivotChartDataReader. It compiles the DSL (shared DSL in
//   _shared/dsl/pivotLayout) into a backend request, runs `run_design_query`
//   (which returns a standard PivotViewResponse), and reuses the pivot→chart
//   extraction verbatim.

import type { PivotViewResponse } from "@api/pivot";
import { getControlValue } from "@api/controlValues";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import {
  compileDesignQuery,
  type DesignQueryRequest,
} from "../../_shared/dsl/pivotLayout/designQuery";
import { substituteControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import { chartsBackend } from "./chartsBackend";
import { extractChartData } from "./pivotChartDataReader";
import type { ParsedChartData, DesignQueryDataSource } from "../types";

/**
 * Read data for a design-query chart and return it as ParsedChartData.
 *
 * Flow: fetch the connection's BI model → compile the DSL into a
 * `DesignQueryRequest` → run it headlessly on the backend → extract categories
 * and series from the returned pivot view.
 */
export async function readDesignQueryData(
  source: DesignQueryDataSource,
): Promise<ParsedChartData> {
  if (!source.connectionId) {
    throw new Error("This design-query chart has no BI connection selected.");
  }

  const biModel = await chartsBackend.invoke<BiPivotModelInfo | null>(
    "get_connection_bi_model",
    { connectionId: source.connectionId },
  );
  if (!biModel) {
    throw new Error(
      "The BI model for this design query is not loaded. Open its connection first.",
    );
  }

  // Resolve @Name params against current control / ribbon-filter values — the
  // same binding standard reports use (a chart's FILTERS can be driven by a
  // pane control or ribbon filter; the shared query-object refresh service
  // re-runs the chart when a bound value changes).
  const substituted = substituteControlParams(source.dslText, getControlValue);
  const compiled = compileDesignQuery(substituted, source.connectionId, biModel);
  if (!compiled.request) {
    const detail = compiled.errors
      .map((e) => `Line ${e.location.line}: ${e.message}`)
      .join("\n");
    throw new Error(`Design query has errors (after @param substitution):\n${detail}`);
  }

  const view = await chartsBackend.invoke<PivotViewResponse>("run_design_query", {
    request: compiled.request satisfies DesignQueryRequest,
  });
  if (!view) {
    return { categories: [], series: [] };
  }

  // A design-query chart's categories come from the data rows only — subtotals
  // and grand totals are excluded (they would be spurious extra categories).
  return extractChartData(view, { includeSubtotals: false, includeGrandTotal: false });
}
