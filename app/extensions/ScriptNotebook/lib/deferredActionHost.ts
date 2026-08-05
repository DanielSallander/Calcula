//! FILENAME: app/extensions/ScriptNotebook/lib/deferredActionHost.ts
// PURPOSE: The live DeferredActionHost — every host call a script can defer.
// CONTEXT: Pure @api wiring (Facade Rule); the decision logic lives in
//          deferredActions.ts. Repaint discipline follows the rest of the app:
//          "grid:refresh" re-fetches cell data (used after data/style writes and
//          sheet switches), AppEvents.GRID_REFRESH only repaints (view toggles).

import { dispatchGridAction } from "@api/gridDispatch";
import {
  getGridStateSnapshot,
  setSelection,
  scrollToCell,
  setActiveSheet as setActiveSheetAction,
  setStatusBarText,
  clearStatusBarText,
  changeViewMode,
  changeReferenceStyle,
  setZoomLevel,
  fillDown as apiFillDown,
  fillRight as apiFillRight,
} from "@api/grid";
import { emitAppEvent, AppEvents } from "@api/events";
import { cellEvents } from "@api/cellEvents";
import {
  setActiveSheet as setActiveSheetBackend,
  hideSheet,
  unhideSheet,
  setScrollArea as apiSetScrollArea,
  setIterationSettings as apiSetIterationSettings,
  applyNamedStyle as apiApplyNamedStyle,
  applyNamedStyleRange as apiApplyNamedStyleRange,
  calculateNow,
} from "@api/lib";
import type { CellData } from "@api/types";
import type { DeferredActionHost } from "./deferredActions";

// ============================================================================
// Repaint helpers
// ============================================================================

/** Re-fetch the visible cells from the backend (data changed, not just pixels). */
function refreshGridData(): void {
  window.dispatchEvent(new CustomEvent("grid:refresh"));
}

/** Push recalculated/reformatted cells into the canvas caches. */
function publishCellUpdates(cells: CellData[]): void {
  if (cells.length === 0) return;
  cellEvents.emitBatch(
    cells.map((cell) => ({
      row: cell.row,
      col: cell.col,
      sheetIndex: cell.sheetIndex,
      newValue: cell.display,
      formula: cell.formula,
    })),
    "script",
  );
}

// ============================================================================
// The live host
// ============================================================================

export const liveDeferredActionHost: DeferredActionHost = {
  getActiveSheetIndex(): number {
    return getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0;
  },

  async activateSheet(sheetIndex: number): Promise<void> {
    // Mirrors the Shell's own sheet-switch sequence: swap in the backend, sync
    // Core state, then let SheetTabs/Spreadsheet re-read dimensions and cells.
    const result = await setActiveSheetBackend(sheetIndex);
    const active = result.sheets[result.activeIndex];
    const name = active?.name ?? "";
    dispatchGridAction(setActiveSheetAction(result.activeIndex, name));
    window.dispatchEvent(
      new CustomEvent("sheet:normalSwitch", {
        detail: { newSheetIndex: result.activeIndex, newSheetName: name },
      }),
    );
    emitAppEvent(AppEvents.SHEET_CHANGED, {
      sheetIndex: result.activeIndex,
      sheetName: name,
    });
    refreshGridData();
  },

  gotoCell(row: number, col: number, select: boolean, endRow: number, endCol: number): void {
    if (select) {
      dispatchGridAction(setSelection(row, col, endRow, endCol));
    }
    // Always scroll to the range's top-left, selecting or not.
    dispatchGridAction(scrollToCell(row, col, false));
  },

  async recalculate(): Promise<void> {
    publishCellUpdates(await calculateNow());
    emitAppEvent(AppEvents.GRID_REFRESH);
  },

  setStatusBar(message: string | null): void {
    if (message === null) {
      clearStatusBarText();
    } else {
      setStatusBarText(message);
    }
  },

  setViewMode(mode): void {
    changeViewMode(mode);
  },

  setZoomPercent(percent: number): void {
    setZoomLevel(percent);
  },

  async setReferenceStyle(style): Promise<void> {
    await changeReferenceStyle(style);
  },

  setDisplayZeros(value: boolean): void {
    emitAppEvent(AppEvents.DISPLAY_ZEROS_TOGGLED, { displayZeros: value });
    emitAppEvent(AppEvents.GRID_REFRESH);
  },

  setDisplayGridlines(value: boolean): void {
    emitAppEvent(AppEvents.DISPLAY_GRIDLINES_TOGGLED, { displayGridlines: value });
    emitAppEvent(AppEvents.GRID_REFRESH);
  },

  setDisplayHeadings(value: boolean): void {
    emitAppEvent(AppEvents.DISPLAY_HEADINGS_TOGGLED, { displayHeadings: value });
    emitAppEvent(AppEvents.GRID_REFRESH);
  },

  setDisplayFormulas(value: boolean): void {
    // Same event the Ctrl+` keyboard toggle and the worker-script surface
    // emit; the payload is the NEW value (set semantics, not toggle).
    emitAppEvent(AppEvents.SHOW_FORMULAS_TOGGLED, { showFormulas: value });
    emitAppEvent(AppEvents.GRID_REFRESH);
  },

  async fillDown(startRow, startCol, endRow, endCol): Promise<void> {
    // @api/grid.fillDown already emits the cell-change batch for the copies.
    await apiFillDown(startRow, startCol, endRow, endCol);
    refreshGridData();
  },

  async fillRight(startRow, startCol, endRow, endCol): Promise<void> {
    await apiFillRight(startRow, startCol, endRow, endCol);
    refreshGridData();
  },

  async applyNamedStyle(
    name: string,
    row: number,
    col: number,
    endRow?: number,
    endCol?: number,
  ): Promise<void> {
    // The rect form goes through the range command (ONE undo transaction);
    // a single cell keeps the row/col-list command.
    const result =
      endRow !== undefined && endCol !== undefined
        ? await apiApplyNamedStyleRange(name, row, col, endRow, endCol)
        : await apiApplyNamedStyle(name, [row], [col]);
    publishCellUpdates(result.cells);
    window.dispatchEvent(new CustomEvent("styles:refresh"));
    refreshGridData();
  },

  async setScrollArea(area: string | null): Promise<void> {
    await apiSetScrollArea(area);
  },

  async setIterationSettings(
    enabled: boolean,
    maxIterations: number,
    maxChange: number,
  ): Promise<void> {
    await apiSetIterationSettings(enabled, maxIterations, maxChange);
  },

  async setSheetVisibility(sheetIndex: number, visibility): Promise<void> {
    const result =
      visibility === "visible"
        ? await unhideSheet(sheetIndex)
        : await hideSheet(sheetIndex, visibility);
    const active = result.sheets[result.activeIndex];
    // Hiding the active sheet makes the backend switch; SheetTabs reloads the
    // tab strip (and the active index) off SHEET_CHANGED.
    emitAppEvent(AppEvents.SHEET_CHANGED, {
      sheetIndex: result.activeIndex,
      sheetName: active?.name ?? "",
    });
    refreshGridData();
  },
};
