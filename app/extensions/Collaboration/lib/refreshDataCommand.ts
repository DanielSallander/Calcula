//! FILENAME: app/extensions/Collaboration/lib/refreshDataCommand.ts
// PURPOSE: Data > Refresh Data (`externalData:refreshData`): verify the data
//          sources of the workbook's subscriptions, then tell the user what it
//          found -- and end the clipboard mode, as Excel's Refresh All does.
// CONTEXT: Lifted out of the extension's activate() so the command's ending can
//          be driven by a test without activating the whole extension
//          (round 17, rev15B). The dialog and the toast stay the caller's.

import { refreshData, type DataRefreshResponse } from "@api/collaboration";
import { AppEvents, emitAppEvent } from "@api/events";

export interface RefreshDataCommandUi {
  /** Open the connection dialog for the data sources that need manual setup. */
  showConnectionDialog(dataSources: DataRefreshResponse["needsConfiguration"]): void;
  showToast(message: string, options: { type: "success" | "info" | "error"; duration: number }): void;
}

/**
 * Run Data > Refresh Data. A refresh that RAN ends the clipboard mode -- a
 * copy's and a cut's -- whatever it found to refresh, as Excel's Data >
 * Refresh All does [LIVE, Excel 16 COM 2026-10-31, clip7/probe-refresh.ps1:
 * ExecuteMso("RefreshAll") sets CutCopyMode to 0 even with nothing to
 * refresh]. A refresh that failed ends nothing.
 */
export async function runRefreshDataCommand(ui: RefreshDataCommandUi): Promise<void> {
  try {
    const result = await refreshData();
    emitAppEvent(AppEvents.DATA_COMMAND_APPLIED, { command: "refresh" });

    if (result.needsConfiguration.length > 0) {
      // Show connection dialog for data sources that need manual setup
      ui.showConnectionDialog(result.needsConfiguration);
    } else if (result.sourcesRefreshed > 0) {
      // Data sources verified -- notify the grid (pivot refresh pulls
      // the actual data through the BI connections)
      emitAppEvent(AppEvents.SHEET_CHANGED, {});
      ui.showToast(`${result.sourcesRefreshed} data source(s) connected and verified`, {
        type: "success",
        duration: 3000,
      });
    } else {
      ui.showToast("No data sources found in subscriptions", { type: "info", duration: 3000 });
    }
  } catch (err) {
    ui.showToast(`Refresh failed: ${err}`, { type: "error", duration: 5000 });
  }
}
