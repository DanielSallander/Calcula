//! FILENAME: app/extensions/Pivot/lib/pivotCellFormulaBar.ts
// PURPOSE: A canvas pivot box's selected CELLS (D-CELLS), as the formula bar,
//          the Name Box and the status bar see them: the box's active cell is
//          published READ-ONLY into Core's external-cell slot (the Name Box
//          shows `Canvas1!B5` or `Canvas1!B5:D9`, the bar shows the cell's
//          unformatted value -- Excel's formula bar over a pivot), and the
//          selected rectangle is published as the status bar's range, so
//          Sum / Count / Average aggregate the pivot's cells.
// CONTEXT: The floating grid is the precedent (FloatingRange/lib/frFormulaBar.ts,
//          owner "floatingRange"); both publish into the same single slots,
//          last writer wins, and every withdrawal here is OWNER-SCOPED, so a
//          pivot that clears its cells late never withdraws what a floating
//          grid published since.
//
//          The cells live in the canvas sheet's HIDDEN GRID: view cell (r, c)
//          is grid cell (region.startRow + r, region.startCol + c). The address
//          is spelled exactly as a reference pick of the same cells inserts it
//          (quoteSheetNameForFormula + "!" + A1, no `$`), so `'Sales Page'!B5`
//          and a block-1 pivot's `Canvas1!AMK1` read the same in both places.
//          The status bar asks the backend about those grid cells on the
//          ACTIVE sheet, which is the canvas the cells are on: the store
//          clears the cells on a real sheet change, and every clear withdraws.
//
//          Content is `getCellDisplayValue(cell.value)`; `null` (the bar shows
//          nothing -- never another cell's text) while a windowed pivot's row
//          is not cached yet. The row is then fetched, and the publish repeats
//          when it lands (also when it lands through the renderer's fetch of
//          the same window: pivotViewStore's window waiters).

import { columnToLetter } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { getGridRegions, onRegionChange } from "@api/gridOverlays";
import {
  publishExternalCellTarget,
  quoteSheetNameForFormula,
  type ExternalCellTarget,
} from "@api/externalEdit";
import { publishStatusBarRange } from "@api/statusBarRange";
import { AppEvents, onAppEvent, type SheetRenamedPayload } from "@api/events";
import { PivotEvents } from "../../_shared/lib/pivotEvents";
import { getCellDisplayValue, getPivotCellWindow } from "./pivot-api";
import { ensureCellWindow, getCachedPivotView } from "./pivotViewStore";
import { getPivotViewRow } from "./pivotChromeActions";
import {
  getPivotCellSelection,
  onPivotCellSelectionChanged,
  pivotCellGridRange,
  type PivotCellRect,
} from "./pivotVisualCellSelection";
import { pivotIdOfVisual } from "./pivotVisualRegions";

/** The owner key the pivot's cells are published under (both slots). */
export const PIVOT_CELLS_OWNER = "pivot-canvas-cells";

/** Whether the publisher is installed (a window landing after uninstall publishes nothing). */
let installed = false;
/** The windowed row a fetch was asked for (one ask per pivot/version/row). */
let awaitingRow: string | null = null;
/**
 * The last rename of a sheet, kept until Core's snapshot (updated on render)
 * catches up: a rename of the canvas the cells are on renames the address now.
 */
let lastRename: SheetRenamedPayload | null = null;

/** `B5`, or `B5:D9` for more than one cell (no `$`: the spelling a pick inserts). */
export function pivotCellA1(rect: PivotCellRect): string {
  const start = `${columnToLetter(rect.startCol)}${rect.startRow + 1}`;
  if (rect.startRow === rect.endRow && rect.startCol === rect.endCol) return start;
  return `${start}:${columnToLetter(rect.endCol)}${rect.endRow + 1}`;
}

/** The ACTIVE sheet's name (a rename not yet in the snapshot wins), or null. */
function activeSheetName(): string | null {
  const ctx = getGridStateSnapshot()?.sheetContext;
  if (!ctx) return null;
  if (
    lastRename !== null &&
    lastRename.sheetIndex === ctx.activeSheetIndex &&
    ctx.activeSheetName === lastRename.oldName
  ) {
    return lastRename.newName;
  }
  return typeof ctx.activeSheetName === "string" && ctx.activeSheetName.length > 0 ? ctx.activeSheetName : null;
}

/**
 * What the bar shows for view cell (row, col) of `pivotId`: the unformatted
 * value; "" for a cell the row does not carry; null while the row is not
 * cached (a windowed pivot's row is then fetched, and this publishes again).
 */
function activeCellContent(pivotId: string, row: number, col: number): string | null {
  const view = getCachedPivotView(pivotId);
  if (!view) return null;
  const rowData = getPivotViewRow(pivotId, view, row);
  if (!rowData) {
    if (view.isWindowed === true) {
      const key = `${pivotId}|${view.version}|${row}`;
      if (awaitingRow !== key) {
        awaitingRow = key;
        ensureCellWindow(pivotId, view.version, row, 1, getPivotCellWindow, () => {
          if (awaitingRow === key) awaitingRow = null;
          publish();
        });
      }
    }
    return null;
  }
  const cell = rowData.cells[col];
  return cell ? getCellDisplayValue(cell.value) : "";
}

function withdraw(): void {
  publishExternalCellTarget(PIVOT_CELLS_OWNER, null);
  publishStatusBarRange(PIVOT_CELLS_OWNER, null);
}

/** Publish the selected cells (or withdraw both slots when there are none). */
function publish(): void {
  if (!installed) return;
  const sel = getPivotCellSelection();
  if (sel === null) {
    awaitingRow = null;
    withdraw();
    return;
  }
  const region = getGridRegions().find((r) => pivotIdOfVisual(r) === sel.pivotId);
  const sheetName = activeSheetName();
  // The box is not published on this sheet (yet), or the sheet cannot be
  // named: no address can be told, so nothing is shown -- never a guess.
  if (!region || sheetName === null || !Number.isInteger(region.startRow) || !Number.isInteger(region.startCol)) {
    withdraw();
    return;
  }
  const gridRect = pivotCellGridRange(sel, region.startRow, region.startCol);
  const target: ExternalCellTarget = {
    address: `${quoteSheetNameForFormula(sheetName)}!${pivotCellA1(gridRect)}`,
    content: activeCellContent(sel.pivotId, sel.anchorRow, sel.anchorCol),
    // A pivot's cells are the pivot's: the bar never edits them (Excel).
    readOnly: true,
    beginEdit: () => null,
  };
  publishExternalCellTarget(PIVOT_CELLS_OWNER, target);
  try {
    publishStatusBarRange(PIVOT_CELLS_OWNER, gridRect);
  } catch (err) {
    console.error("[PivotCellFormulaBar] The status bar range was refused:", err);
    publishStatusBarRange(PIVOT_CELLS_OWNER, null);
  }
}

/**
 * Install the publisher: it follows the cell selection, each new view of a
 * pivot (the active cell's value changed), the published regions (the box's
 * anchor) and sheet renames. The cleanups withdraw both publications.
 */
export function installPivotCellFormulaBar(): Array<() => void> {
  installed = true;
  awaitingRow = null;
  lastRename = null;
  const cleanups: Array<() => void> = [];
  cleanups.push(onPivotCellSelectionChanged(() => publish()));
  cleanups.push(
    onAppEvent<{ pivotId?: unknown } | undefined>(PivotEvents.PIVOT_VIEW_UPDATED, (detail) => {
      const sel = getPivotCellSelection();
      if (sel !== null && detail?.pivotId === sel.pivotId) publish();
    }),
  );
  cleanups.push(onRegionChange(() => publish()));
  cleanups.push(
    onAppEvent<SheetRenamedPayload | undefined>(AppEvents.SHEET_RENAMED, (detail) => {
      if (
        detail &&
        typeof detail.sheetIndex === "number" &&
        typeof detail.oldName === "string" &&
        typeof detail.newName === "string"
      ) {
        lastRename = { sheetIndex: detail.sheetIndex, oldName: detail.oldName, newName: detail.newName };
      }
      publish();
    }),
  );
  publish();
  cleanups.push(() => {
    installed = false;
    awaitingRow = null;
    lastRename = null;
    withdraw();
  });
  return cleanups;
}
