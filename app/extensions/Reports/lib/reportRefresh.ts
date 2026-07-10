//! FILENAME: app/extensions/Reports/lib/reportRefresh.ts
// PURPOSE: Refresh a grid report — resolve its @Control params against current
//   pane-control / ribbon-filter values, recompile the design query, and
//   re-materialize. Used by manual refresh (Manage Reports) and auto-refresh on
//   control-value changes. Failures are returned (not swallowed) so manual
//   refresh can surface them; auto-refresh logs them.

import { getControlValue } from "@api/controlValues";
import { emitAppEvent, AppEvents } from "@api/events";
import type { BiPivotModelInfo } from "../../_shared/components/types";
import {
  compileDesignQuery,
  type DesignQueryRequest,
} from "../../_shared/dsl/pivotLayout/designQuery";
import { reportsBackend } from "./reportsBackend";
import {
  dslReferencesControl,
  hasControlParams,
  substituteControlParams,
} from "./paramSubstitution";
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
 */
export async function refreshReport(
  report: ReportInfo,
  opts?: { auto?: boolean },
): Promise<RefreshResult> {
  const biModel = await getModel(report.connectionId);
  if (!biModel) {
    return {
      ok: false,
      message: "The BI model for this report's connection is not loaded.",
    };
  }
  const substituted = substituteControlParams(report.dslText, getControlValue);
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
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/** Refresh a single report (manual), repaint the grid, and return the outcome. */
export async function refreshOneReport(report: ReportInfo): Promise<RefreshResult> {
  const result = await refreshReport(report);
  if (result.ok) emitAppEvent(AppEvents.GRID_REFRESH);
  return result;
}

// ---------------------------------------------------------------------------
// Control-driven auto-refresh (coalesced)
// ---------------------------------------------------------------------------

// One pass runs at a time; changes arriving mid-pass are merged into a pending
// set and served by a single follow-up pass (prevents overlapping refreshes of
// the same report racing each other).
let inFlight = false;
/** undefined = nothing pending; null = pending "all @-bound"; else names. */
let pendingNames: Set<string> | null | undefined;

async function runControlBoundRefresh(names: Set<string> | null): Promise<void> {
  const reports = await listReports();
  const affected = reports.filter((r) =>
    names ? dslReferencesControl(r.dslText, names) : hasControlParams(r.dslText),
  );
  if (affected.length === 0) return;
  let any = false;
  for (const r of affected) {
    const result = await refreshReport(r, { auto: true });
    if (result.ok) {
      any = true;
    } else {
      console.warn(`[Reports] Auto-refresh of "${r.name}" failed: ${result.message}`);
    }
  }
  if (any) emitAppEvent(AppEvents.GRID_REFRESH);
}

/**
 * Refresh the reports bound (via @Name in FILTERS) to the given changed control
 * names — or every @-bound report when no names are given. Concurrent calls
 * coalesce into one follow-up pass.
 */
export async function refreshControlBoundReports(
  changedNames?: Iterable<string>,
): Promise<void> {
  const requested: Set<string> | null = changedNames ? new Set(changedNames) : null;
  if (inFlight) {
    if (pendingNames === undefined) {
      pendingNames = requested;
    } else if (pendingNames === null || requested === null) {
      pendingNames = null;
    } else {
      for (const n of requested) pendingNames.add(n);
    }
    return;
  }
  inFlight = true;
  try {
    let current: Set<string> | null = requested;
    for (;;) {
      await runControlBoundRefresh(current);
      if (pendingNames === undefined) break;
      current = pendingNames;
      pendingNames = undefined;
    }
  } finally {
    inFlight = false;
  }
}
