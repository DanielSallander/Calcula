//! FILENAME: app/extensions/Charts/lib/designQueryCommit.ts
// PURPOSE: THE one write of a design-query chart's query from the object
//          pane (WP-C S9b): the Fields tab's wells, the Design tab's editor
//          (Apply / blur) and the connection select all end here.
// CONTEXT: One fact, one write, one undo step:
//            - VALIDATED FIRST, against the connection's model, with the
//              live @Name params substituted exactly as the reader compiles
//              it (designQueryChartDataReader.compileDesignQuerySource). A
//              query that does not compile is REFUSED with the compiler's
//              sentences and nothing is written -- the chart keeps drawing
//              the last good query;
//            - an UNCHANGED query (same meaning by `sameDesignQuery`, same
//              connection, same gauge indices) writes nothing, so a blur after
//              an Apply, or a wells click that changes nothing, leaves no
//              empty undo step and does not dirty the document;
//            - otherwise ONE `updateChartSpec(chartId, { data, markOptions? })`
//              and the applySpec choreography (cache, regions,
//              CHART_UPDATED) inside `runInUndoTransaction("Edit chart
//              data")`, with the debounced `update_chart` FLUSHED before the
//              transaction closes. Without the flush the write lands 300 ms
//              after the step closed: a separate, unlabelled undo step (the
//              chartGeometry / chartObjectFormat precedent, review R1-4).
//          A backend refusal of the write (a protected sheet) is rolled back
//          by the store and returned as the editor's error; another chart's
//          refusal that the flush happened to carry is reported the store's
//          usual way.

import { runInUndoTransaction } from "@api/objectGeometry";
import { getControlValue } from "@api/controlValues";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import { compileDesignQuery } from "../../_shared/dsl/pivotLayout/designQuery";
import { sameDesignQuery } from "../../_shared/dsl/pivotLayout/canonical";
import { substituteControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import { invalidateChartCache } from "../rendering/chartRenderer";
import type { ChartSpec, DesignQueryDataSource, GaugeMarkOptions } from "../types";
import { isDesignQueryDataSource } from "../types";
import { ChartEvents } from "./chartEvents";
import {
  flushPendingChartSavesQuietly,
  getChartById,
  reportChartFailures,
  syncChartRegions,
  updateChartSpec,
} from "./chartStore";
import { chartsBackend } from "./chartsBackend";

/** The undo label of a query edit from the object pane. */
export const DESIGN_QUERY_UNDO_LABEL = "Edit chart data";

/** What a commit writes. */
export interface DesignQueryCommitRequest {
  dslText: string;
  connectionId: string;
  /** A gauge's series indices, written in the SAME step (undefined = cleared). */
  markOptions?: Pick<GaugeMarkOptions, "targetSeriesIndex" | "minSeriesIndex" | "maxSeriesIndex"> | null;
}

/** The outcome, as the editors show it. */
export type DesignQueryCommitResult =
  | { status: "written" }
  | { status: "unchanged" }
  | { status: "refused"; error: string };

export const DESIGN_QUERY_NO_CHART = "The chart no longer exists.";
export const DESIGN_QUERY_NOT_A_QUERY = "This chart does not run a design query.";
export const DESIGN_QUERY_NO_CONNECTION = "Select a BI connection first.";
export const DESIGN_QUERY_MODEL_NOT_LOADED =
  "The BI model for this connection is not loaded. Open its connection first.";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The compiler's refusal of a query, as the editor shows it; null when it compiles. */
export function designQueryRefusal(dslText: string, connectionId: string, biModel: BiPivotModelInfo): string | null {
  const compiled = compileDesignQuery(substituteControlParams(dslText, getControlValue), connectionId, biModel);
  if (compiled.request) return null;
  return compiled.errors.map((e) => `Line ${e.location.line}: ${e.message}`).join("\n") || "The query does not compile.";
}

/** Whether a commit would change nothing the chart stores. */
function isUnchanged(spec: ChartSpec, source: DesignQueryDataSource, request: DesignQueryCommitRequest): boolean {
  if (source.connectionId !== request.connectionId) return false;
  if (source.dslText !== request.dslText && !sameDesignQuery(source.dslText, request.dslText)) return false;
  if (request.markOptions) {
    const current = (spec.markOptions ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(request.markOptions)) {
      if (current[k] !== v) return false;
    }
  }
  return true;
}

/**
 * Validate and write a design-query chart's query (see the file header).
 * Never throws: a refusal is the result.
 */
export async function commitDesignQuery(
  chartId: string,
  request: DesignQueryCommitRequest,
): Promise<DesignQueryCommitResult> {
  const before = getChartById(chartId);
  if (!before) return { status: "refused", error: DESIGN_QUERY_NO_CHART };
  if (!isDesignQueryDataSource(before.spec.data)) return { status: "refused", error: DESIGN_QUERY_NOT_A_QUERY };
  if (!request.connectionId) return { status: "refused", error: DESIGN_QUERY_NO_CONNECTION };

  let biModel: BiPivotModelInfo | null;
  try {
    biModel = await chartsBackend.invoke<BiPivotModelInfo | null>("get_connection_bi_model", {
      connectionId: request.connectionId,
    });
  } catch (err) {
    return { status: "refused", error: errorText(err) };
  }
  if (!biModel) return { status: "refused", error: DESIGN_QUERY_MODEL_NOT_LOADED };
  const refusal = designQueryRefusal(request.dslText, request.connectionId, biModel);
  if (refusal !== null) return { status: "refused", error: refusal };

  // Re-read after the await: the chart may have changed or gone meanwhile.
  const chart = getChartById(chartId);
  if (!chart) return { status: "refused", error: DESIGN_QUERY_NO_CHART };
  if (!isDesignQueryDataSource(chart.spec.data)) return { status: "refused", error: DESIGN_QUERY_NOT_A_QUERY };
  if (isUnchanged(chart.spec, chart.spec.data, request)) return { status: "unchanged" };

  const patch: Partial<ChartSpec> = {
    data: { type: "designQuery", dslText: request.dslText, connectionId: request.connectionId },
  };
  if (request.markOptions) {
    // An explicit undefined CLEARS a key in the store's deep merge.
    patch.markOptions = { ...request.markOptions } as ChartSpec["markOptions"];
  }

  try {
    await runInUndoTransaction(DESIGN_QUERY_UNDO_LABEL, async () => {
      updateChartSpec(chartId, patch);
      invalidateChartCache(chartId);
      syncChartRegions();
      window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
      const failures = await flushPendingChartSavesQuietly();
      const mine = failures.filter((f) => f.chartId === chartId);
      const other = failures.filter((f) => f.chartId !== chartId);
      if (other.length > 0) void reportChartFailures(other);
      if (mine.length > 0) {
        // The store rolled the chart back; repaint what it now holds.
        invalidateChartCache(chartId);
        syncChartRegions();
        window.dispatchEvent(new Event(ChartEvents.CHART_UPDATED));
        throw new Error(mine.map((f) => f.reason).filter((r) => r !== "").join(" ") || "The chart could not be saved.");
      }
    });
  } catch (err) {
    return { status: "refused", error: errorText(err) };
  }
  return { status: "written" };
}
