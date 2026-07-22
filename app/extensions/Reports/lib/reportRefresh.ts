//! FILENAME: app/extensions/Reports/lib/reportRefresh.ts
// PURPOSE: Refresh a grid report — resolve its @Control params against current
//   pane-control / ribbon-filter values, recompile the design query, and
//   re-materialize. Used by manual refresh (Manage Reports) and auto-refresh on
//   control-value changes. Failures are returned (not swallowed) so manual
//   refresh can surface them; auto-refresh logs them.

import { getControlValue } from "@api/controlValues";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import {
  compileDesignQuery,
  type DesignQueryRequest,
} from "../../_shared/dsl/pivotLayout/designQuery";
import { reportsBackend } from "./reportsBackend";
import { substituteControlParams } from "../../_shared/dsl/pivotLayout/paramSubstitution";
import type { ReportInfo } from "../types";

// The BI model schema is cached per connection so control-driven refreshes don't
// re-fetch it each time. Only successful fetches are cached (a model that isn't
// loaded yet must be retried, not remembered as absent); the cache is cleared on
// BI connection/model events (see Reports/index.ts).
const modelCache = new Map<string, BiPivotModelInfo>();

async function getModel(connectionId: string): Promise<BiPivotModelInfo | null> {
  const cached = modelCache.get(connectionId);
  if (cached) return cached;
  const m = await reportsBackend
    .invoke<BiPivotModelInfo | null>("get_connection_bi_model", { connectionId })
    .catch(() => null);
  if (m) modelCache.set(connectionId, m);
  return m ?? null;
}

/** Drop cached models (wired to the BI connection/model-refresh events). */
export function clearReportModelCache(): void {
  modelCache.clear();
}

/**
 * Ask the canvas to REFETCH styles + cell data and repaint. Report cells are
 * written backend-side, so the frontend caches must refresh — the app-level
 * AppEvents.GRID_REFRESH only redraws overlays from the cached cells and would
 * leave freshly materialized cells invisible until the next scroll/sheet
 * switch. Materialization also CREATES new styles (header fills, bold, number
 * formats) in the backend StyleRegistry, so the style cache must refetch too or
 * the report renders unstyled. Same raw events AutoFilter / PasteSpecial /
 * FormatCells dispatch after their backend writes.
 */
export function refreshGridCells(): void {
  window.dispatchEvent(new CustomEvent("styles:refresh"));
  window.dispatchEvent(new CustomEvent("grid:refresh"));
}

/** List all reports (empty on failure). */
export async function listReports(): Promise<ReportInfo[]> {
  return (await reportsBackend.invoke<ReportInfo[]>("list_reports").catch(() => [])) ?? [];
}

/** Outcome of one report refresh. `message` says why when `ok` is false. */
export interface RefreshResult {
  ok: boolean;
  message?: string;
  /** Non-empty cells outside the previous region the write covered (when ok). */
  overwrittenCellCount?: number;
}

interface BackendReportResult {
  reportId: string;
  rowCount: number;
  colCount: number;
  overwrittenCellCount: number;
}

/**
 * Re-run one report's query (resolving its @Control params) and re-materialize.
 * Never throws — failures come back as `{ ok: false, message }`.
 * `auto` marks control-driven refreshes: the backend skips the undo entry for
 * them unless the write would cover user data outside the report's region.
 * `updateDsl` (Edit Design Query) persists a new DSL text / name in the same
 * backend call, so cells + definition change as one undo step.
 */
export async function refreshReport(
  report: ReportInfo,
  opts?: { auto?: boolean; updateDsl?: { dslText: string; name?: string } },
): Promise<RefreshResult> {
  const biModel = await getModel(report.connectionId);
  if (!biModel) {
    return {
      ok: false,
      message: "The BI model for this report's connection is not loaded.",
    };
  }
  const dslText = opts?.updateDsl?.dslText ?? report.dslText;
  const substituted = substituteControlParams(dslText, getControlValue);
  const compiled = compileDesignQuery(substituted, report.connectionId, biModel);
  if (!compiled.request) {
    const details = compiled.errors
      .map((e) => `Line ${e.location.line}: ${e.message}`)
      .join("\n");
    return {
      ok: false,
      message: `The design query has errors (after @param substitution):\n${details || "unknown compile error"}`,
    };
  }
  try {
    const result = await reportsBackend.invoke<BackendReportResult>("refresh_report", {
      request: {
        reportId: report.id,
        query: compiled.request satisfies DesignQueryRequest,
        auto: opts?.auto ?? false,
        dslText: opts?.updateDsl?.dslText,
        name: opts?.updateDsl?.name,
      },
    });
    return { ok: true, overwrittenCellCount: result?.overwrittenCellCount };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

/** Delete a report and refresh the grid. */
export async function deleteReport(reportId: string): Promise<void> {
  await reportsBackend.invoke("delete_report", { reportId });
  refreshGridCells();
}

/** Refresh a single report (manual), repaint the grid, and return the outcome. */
export async function refreshOneReport(report: ReportInfo): Promise<RefreshResult> {
  const result = await refreshReport(report);
  if (result.ok) refreshGridCells();
  return result;
}

// Control-driven auto-refresh lives in the SHARED query-object refresh service
// (_shared/lib/queryObjectRefresh.ts — one debounce/targeting/coalescing brain
// for every query-bound object family); this extension registers its provider
// in reportQueryProvider.ts.
