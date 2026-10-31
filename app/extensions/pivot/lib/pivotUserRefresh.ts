//! FILENAME: app/extensions/Pivot/lib/pivotUserRefresh.ts
// PURPOSE: The USER's Refresh of one PivotTable -- the pivot's right-click
//          Refresh and PivotTable Analyze > Refresh -- as one door.
// CONTEXT: Excel ends the clipboard mode, a copy's and a cut's, on a
//          PivotTable's Refresh [LIVE 2026-10-31, clip7/probe-refresh.ps1:
//          PivotTable.RefreshTable with F6 copied -> CutCopyMode 0; the UI's
//          Data > Refresh All too], while a bare cache refresh keeps it
//          (PivotCache.Refresh, Workbook.RefreshAll over COM -> still xlCopy).
//          So the user's door announces DATA_COMMAND_APPLIED { command:
//          "refresh" } once the refresh LANDED -- never for a refused one --
//          and every internal or scripted `refreshPivotCache` (a table-linked
//          pivot following its table, a writeback commit's re-read,
//          `pivot.refreshCache` / `pivot.refreshAll`) keeps a pending copy, as
//          Excel's cache refresh does. Round 16 (NEW-pivot-refresh-keeps-
//          clipboard-mode).

import { AppEvents, emitAppEvent } from "@api";
import type { DataCommandAppliedPayload } from "@api/events";
import { refreshPivotCache } from "./pivot-api";

/**
 * Refresh one PivotTable for the user: re-read its source, repaint every pivot
 * consumer (`pivot:refresh`), and end copy / cut mode as Excel's Refresh does.
 * Throws what the refresh threw (a pivot not connected to its model, a refused
 * overwrite), having announced nothing.
 */
export async function refreshPivotForUser(pivotId: string): Promise<void> {
  await refreshPivotCache(pivotId);
  window.dispatchEvent(new Event("pivot:refresh"));
  const ended: DataCommandAppliedPayload = { command: "refresh" };
  emitAppEvent(AppEvents.DATA_COMMAND_APPLIED, ended);
}
