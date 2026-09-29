//! FILENAME: app/src/api/sheetSwitch.ts
// PURPOSE: ONE door for "make sheet N the active sheet" from an extension --
//          the same switch a tab click makes, step for step.
// CONTEXT: Extensions hand-rolled the switch, and it drifted:
//            - Cell Bookmarks' Next/Previous and the view-bookmark restore did
//              NOT await the backend switch before announcing it. SheetTabs
//              re-reads the sheet list on SHEET_CHANGED, and that read could be
//              answered BEFORE the switch landed: it reported the old sheet as
//              active and dispatched it back, so a jump from a canvas left the
//              backend on Sheet1 and the grid on the canvas (found live
//              2026-09-29, e2e fixall-edit X16).
//            - the Application Explorer, Go To (Tracing), the CSV import and a
//              notebook's Send to grid switched the BACKEND only, so the grid
//              and the tab strip never followed.
//            - none of them fired `sheet:beforeSwitch` / `sheet:normalSwitch`,
//              which are what save the sheet being left, refetch the new
//              sheet's cells (GridCanvas), refresh its dimensions and restore
//              its selection (Spreadsheet), and check its styles.
//          The sequence is SheetTabs' normal tab click (and the Name Box's
//          switchToSheet, which copies it): beforeSwitch, the backend switch,
//          `primeSheetSwitch` (BUG-0052: the canvas repaints the new sheet in
//          the same flush as the strip), Core's sheet context with the sheet's
//          own surface, normalSwitch, SHEET_CHANGED. This is a seam (Seam Rule):
//          callers say WHICH sheet; how a switch is made lives here.

import { setActiveSheet as setActiveSheetBackend } from "../core/lib/tauri-api";
import type { SheetsResult } from "../core/lib/tauri-api";
import { primeSheetSwitch } from "../core/lib/sheetSwitchPrefetch";
import { setActiveSheet } from "../core/state/gridActions";
import { getGridStateSnapshot } from "../core/state/GridContext";
import { dispatchGridAction } from "./gridDispatch";
import { AppEvents, emitAppEvent } from "./events";

/**
 * Make `index` the active sheet, exactly as a tab click does. Everything the
 * switch moves has moved when the promise resolves -- a caller that then
 * selects a cell (a bookmark, Go To) has the last word over the sheet's
 * restored selection. Returns the backend's answer; the sheet it reports
 * active is the one switched to.
 */
export async function activateSheet(index: number): Promise<SheetsResult> {
  window.dispatchEvent(
    new CustomEvent("sheet:beforeSwitch", {
      detail: {
        oldSheetIndex: getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0,
        newSheetIndex: index,
      },
    }),
  );
  const result = await setActiveSheetBackend(index);
  await primeSheetSwitch(result.activeIndex);
  // By the index FIELD, never list position: object-backed sheets are absent
  // from the list while indices stay true.
  const active = result.sheets.find((s) => s.index === result.activeIndex);
  const name = active?.name ?? "";
  // No await from here on: the context, the grid's refetch and the tab strip
  // move in one flush.
  dispatchGridAction(setActiveSheet(result.activeIndex, name, active?.kind === "canvas" ? "canvas" : "grid"));
  window.dispatchEvent(
    new CustomEvent("sheet:normalSwitch", {
      detail: { newSheetIndex: result.activeIndex, newSheetName: name },
    }),
  );
  emitAppEvent(AppEvents.SHEET_CHANGED, { sheetIndex: result.activeIndex, sheetName: name });
  return result;
}
