//! FILENAME: app/extensions/Reports/lib/reportRefresh.ts
// PURPOSE: Refresh a grid report — resolve its @Control params against current
//   pane-control values, recompile the design query, and re-materialize. Used by
//   manual refresh (Manage Reports) and auto-refresh on control-value changes.

import { getControlValue } from "@api/controlValues";
import { emitAppEvent, AppEvents } from "@api/events";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import {
  compileDesignQuery,
  type DesignQueryRequest,
} from "../../_shared/dsl/pivotLayout/designQuery";
import { reportsBackend } from "./reportsBackend";
import { hasControlParams, substituteControlParams } from "./paramSubstitution";
import type { ReportInfo } from "../types";

// The BI model schema is stable within a session; cache it per connection so
// control-driven refreshes don't re-fetch it each time.
const modelCache = new Map<string, BiPivotModelInfo | null>();

async function getModel(connectionId: string): Promise<BiPivotModelInfo | null> {
  if (modelCache.has(connectionId)) return modelCache.get(connectionId) ?? null;
  const m = await reportsBackend
    .invoke<BiPivotModelInfo | null>("get_connection_bi_model", { connectionId })
    .catch(() => null);
  modelCache.set(connectionId, m ?? null);
  return m ?? null;
}

/** Drop cached models (e.g. after a BI model reload). */
export function clearReportModelCache(): void {
  modelCache.clear();
}

/** List all reports (empty on failure). */
export async function listReports(): Promise<ReportInfo[]> {
  return (await reportsBackend.invoke<ReportInfo[]>("list_reports").catch(() => [])) ?? [];
}

/**
 * Re-run one report's query (resolving its @Control params) and re-materialize.
 * Returns true if it ran. Throws on a hard backend error (callers may catch).
 */
export async function refreshReport(report: ReportInfo): Promise<boolean> {
  const biModel = await getModel(report.connectionId);
  if (!biModel) return false; // model not loaded — cannot compile
  const substituted = substituteControlParams(report.dslText, getControlValue);
  const compiled = compileDesignQuery(substituted, report.connectionId, biModel);
  if (!compiled.request) return false; // DSL errors — skip
  await reportsBackend.invoke("refresh_report", {
    request: { reportId: report.id, query: compiled.request satisfies DesignQueryRequest },
  });
  return true;
}

/** Delete a report and refresh the grid. */
export async function deleteReport(reportId: string): Promise<void> {
  await reportsBackend.invoke("delete_report", { reportId });
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/** Refresh a single report and repaint the grid. */
export async function refreshOneReport(report: ReportInfo): Promise<void> {
  await refreshReport(report);
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Refresh every report whose DSL references an @Control param (called when a
 * pane control's value changes). Silent per-report failures don't block others.
 */
export async function refreshControlBoundReports(): Promise<void> {
  const reports = await listReports();
  const affected = reports.filter((r) => hasControlParams(r.dslText));
  if (affected.length === 0) return;
  let any = false;
  for (const r of affected) {
    try {
      const ran = await refreshReport(r);
      any = any || ran;
    } catch {
      /* skip this report */
    }
  }
  if (any) emitAppEvent(AppEvents.GRID_REFRESH);
}
